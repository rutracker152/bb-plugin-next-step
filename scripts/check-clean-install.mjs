import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "bb-next-step-clean-"));
const production = join(temporary, "production");
const development = join(temporary, "development");
const dataDir = join(temporary, "bb-data");
// In particular, never inherit the user's server, thread, project or CLI credentials.
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BB_")));
const report = { package: "bb-plugin-next-step", version: "0.1.0", node: process.version, checkedAt: new Date().toISOString(), steps: [] };
let server;
let serverOutput = "";

async function run(label, command, args, cwd, env = isolatedEnv) {
  process.stdout.write(`${label}\n`);
  const started = Date.now();
  try {
    const result = await exec(command, args, { cwd, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    report.steps.push({ name: label, ok: true, durationMs: Date.now() - started });
    return result.stdout.trim();
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout.slice(-6000));
    if (error.stderr) process.stderr.write(error.stderr.slice(-6000));
    throw error;
  }
}

async function copySource(target) {
  const excluded = new Set(["node_modules", "dist", "test-results", ".git", "coverage"]);
  await cp(source, target, {
    recursive: true,
    filter: (path) => !excluded.has(basename(path)) &&
      !basename(path).startsWith(".env") && !/\.(?:log|tgz)$/u.test(path),
  });
}

async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  const port = address.port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

try {
  await Promise.all([copySource(production), copySource(development)]);
  const manifest = JSON.parse(await readFile(join(production, "package.json"), "utf8"));
  report.version = manifest.version;
  assert.equal(manifest.license, "MIT");
  await readFile(join(production, "LICENSE"), "utf8");

  await run("Production: install without devDependencies or lifecycle scripts", "npm",
    ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], production);
  await assert.rejects(readFile(join(production, "node_modules/@get-bb/plugin-sdk/package.json")), { code: "ENOENT" });
  await run("Production: build server, app and host from source", "bb", ["plugin", "build", "."], production);
  for (const artifact of ["app", "host", "server"]) {
    const metadata = JSON.parse(await readFile(join(production, "dist", `${artifact}.meta.json`), "utf8"));
    assert.equal(metadata.pluginId, "next-step");
    assert.equal(metadata.pluginVersion, manifest.version);
    await readFile(join(production, "dist", `${artifact}.js`));
  }

  await run("Development: install the exact lockfile in another clean copy", "npm",
    ["ci", "--include=dev", "--no-audit", "--no-fund"], development);
  await run("Development: typecheck", "npm", ["run", "typecheck"], development);
  const testOutput = await run("Development: tests", "npm", ["test"], development);
  process.stdout.write(`${testOutput.replace(/\u001b\[[0-9;]*m/gu, "").split("\n").filter((line) => /Tests\s+\d+ passed/u.test(line)).join("\n")}\n`);

  const serverPort = await freePort();
  let daemonPort = await freePort();
  while (daemonPort === serverPort) daemonPort = await freePort();
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const serverEnv = { ...isolatedEnv, BB_DATA_DIR: dataDir, BB_TELEMETRY: "false" };
  const cliEnv = { ...serverEnv, BB_SERVER_URL: baseUrl };
  process.stdout.write("Start a separate BB server with an empty data directory\n");
  server = spawn("bb-app", [
    "--bundled", "--no-in-app-updates", "--data-dir", dataDir,
    "--server-bind-host", "127.0.0.1", "--server-port", String(serverPort),
    "--host-daemon-port", String(daemonPort),
  ], { env: serverEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let startError;
  server.on("error", (error) => { startError = error; });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-10000); });
  const deadline = Date.now() + 60000;
  while (true) {
    if (startError) throw startError;
    if (server.exitCode !== null) throw new Error(`Temporary BB exited: ${serverOutput}`);
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* Wait for this instance to listen. */ }
    if (Date.now() > deadline) throw new Error(`Temporary BB did not start: ${serverOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const context = JSON.parse(await run("Verify the CLI targets only the temporary BB", "bb", ["status", "--json"], production, cliEnv));
  assert.equal(resolve(context.dataDir), resolve(dataDir));
  assert.equal(context.thread, null);

  await run("Install the production-only copy into the empty BB", "bb", ["plugin", "install", production, "--yes", "--json"], production, cliEnv);
  const inventory = JSON.parse(await run("Verify plugin load and frontend compatibility", "bb", ["plugin", "list", "--json"], production, cliEnv));
  const installed = inventory.plugins.find((plugin) => plugin.id === "next-step");
  assert.equal(installed?.status, "running");
  assert.equal(installed?.app?.bundle?.compatible, true);
  assert.equal(installed.rootDir, production);
  const status = JSON.parse(await run("Run the installed plugin's command", "bb", ["next-step", "status", "--json"], production, cliEnv));
  assert.deepEqual(status, { enabled: true, activeRequests: 0 });
  await run("Disable suggestions in the test BB", "bb", ["plugin", "config", "next-step", "set", "enabled", "false"], production, cliEnv);
  const disabled = JSON.parse(await run("Verify the changed setting", "bb", ["next-step", "status", "--json"], production, cliEnv));
  assert.equal(disabled.enabled, false);
  await run("Enable suggestions in the test BB", "bb", ["plugin", "config", "next-step", "set", "enabled", "true"], production, cliEnv);
  const enabled = JSON.parse(await run("Verify the restored setting", "bb", ["next-step", "status", "--json"], production, cliEnv));
  assert.deepEqual(enabled, { enabled: true, activeRequests: 0 });

  report.ok = true;
  await mkdir(join(source, "test-results"), { recursive: true });
  await writeFile(join(source, "test-results", "clean-install.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write("CLEAN_INSTALL_PASSED\n");
} finally {
  if (server && server.exitCode === null) {
    const closed = once(server, "close");
    server.kill("SIGTERM");
    let timer;
    const graceful = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 7000); }),
    ]);
    clearTimeout(timer);
    if (!graceful && server.pid) {
      if (process.platform === "win32") server.kill("SIGKILL");
      else { try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      await closed;
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
