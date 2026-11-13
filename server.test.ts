import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { parseSuggestion, suggestionPrompt } from "./logic";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup(complete = vi.fn(async () => ({ suggestion: "Добавь переключатель в настройках." }))) {
  let thread = makeThreadResponse({ id: "thread-test", providerId: "codex", status: "idle", environmentId: "env-test" });
  let output = "Могу добавить переключатель этой функции в настройках.";
  const host = createFakePluginHost({
    pluginId: "next-step",
    sdk: {
      threads: {
        get: async () => thread,
        output: async () => ({ output }),
        promptHistory: async () => [{ id: "prompt-1", createdAt: 1, input: [{ type: "text", text: "Сделай подсказки." }] }],
        defaultExecutionOptions: async () => ({ model: "gpt-6.1-sol" }),
      },
      environments: { get: async () => ({ hostId: "host-test" }) },
    },
    experimental_callHostRpc: complete,
  });
  plugin(host.bb);
  hosts.push(host);
  return {
    ...host, complete,
    request: () => host.harness.behavior.callRpc("suggest", { threadId: thread.id }),
    setOutput: (next: string) => { output = next; },
    setThread: (next: Partial<typeof thread>) => { thread = { ...thread, ...next }; },
    thread: () => thread,
  };
}

describe("next-message generation", () => {
  it("shares one Codex call across windows, caches it, and refreshes for a different answer", async () => {
    const host = setup();
    const [first, second] = await Promise.all([host.request(), host.request()]);
    expect(first).toMatchObject({ text: "Добавь переключатель в настройках." });
    expect(second).toEqual(first);
    await expect(host.request()).resolves.toEqual(first);
    expect(host.complete).toHaveBeenCalledTimes(1);
    expect(host.harness.experimental_hostRpcCalls[0]).toMatchObject({ hostId: "host-test", method: "complete" });
    host.setOutput("Настройки добавлены. Могу показать, как пользоваться функцией.");
    await host.request();
    expect(host.complete).toHaveBeenCalledTimes(2);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it.each([
    { status: "active" as const }, { status: "error" as const }, { providerId: "claude" }, { archivedAt: 123 },
  ])("does not generate for an ineligible thread: %j", async (state) => {
    const host = setup();
    host.setThread(state);
    await expect(host.request()).resolves.toEqual({ key: null, text: null });
    expect(host.complete).not.toHaveBeenCalled();
  });

  it("does not call Codex when disabled", async () => {
    const host = setup();
    await host.harness.behavior.setSettings({ enabled: false });
    await expect(host.request()).resolves.toEqual({ key: null, text: null });
    expect(host.complete).not.toHaveBeenCalled();
  });

  it("cancels generation when another turn starts and does not cache its late result", async () => {
    let finish!: (value: { suggestion: string }) => void;
    const complete = vi.fn(() => new Promise<{ suggestion: string }>((resolve) => { finish = resolve; }));
    const host = setup(complete);
    const request = host.request();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    host.setThread({ status: "active" });
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: host.thread() });
    finish({ suggestion: "Это уже устарело." });
    await expect(request).resolves.toEqual({ key: null, text: null });
    expect(await host.bb.storage.kv.get("suggestion:thread-test")).toBeUndefined();
  });

  it("allows no suggestion when a task is finished", () => {
    expect(parseSuggestion({ suggestion: null })).toBeNull();
    expect(parseSuggestion({ suggestion: "<script>bad</script>" })).toBeNull();
    expect(parseSuggestion({ suggestion: "x".repeat(181) })).toBeNull();
    expect(suggestionPrompt(["а".repeat(50000)], "б".repeat(50000)).length).toBeLessThan(16000);
    expect(suggestionPrompt(Array(3).fill('"\\\n'.repeat(10000)), '\u0000'.repeat(50000)).length).toBeLessThan(16000);
  });
});
