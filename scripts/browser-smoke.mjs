import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const server = process.env.BB_SERVER_URL;
const threadId = process.env.NEXT_STEP_SMOKE_THREAD_ID ?? process.env.BB_THREAD_ID;
const projectId = process.env.BB_PROJECT_ID;
assert(server && threadId && projectId, "Set BB_SERVER_URL, BB_PROJECT_ID and NEXT_STEP_SMOKE_THREAD_ID (an idle Codex thread).");
const suggestion = "Добавь переключатель подсказок в настройках.";
const browser = await chromium.launch({ headless: true });
await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });

try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    } : { viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let generation = 1;
    let requests = 0;
    await page.route("**/api/v1/plugins/next-step/rpc/suggest", (route) => {
      requests++;
      return route.fulfill({ json: { ok: true, result: { key: `smoke-${generation}`, text: suggestion } } });
    });
    await page.goto(`${server}/projects/${projectId}/threads/${threadId}`, { waitUntil: "domcontentloaded" });
    const editor = page.locator('[data-promptbox-input-region] [contenteditable="true"]').first();
    const ghost = page.locator("[data-next-step-ghost]");
    await editor.waitFor({ timeout: 30000 });
    await ghost.waitFor({ state: "visible", timeout: 15000 });
    assert.equal((await editor.innerText()).trim(), "");
    const bounds = await ghost.boundingBox();
    assert(bounds && bounds.width > 100 && bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1440));
    await page.locator("[data-composer-box]").last().screenshot({
      path: new URL(`../test-results/${mobile ? "mobile" : "desktop"}-suggestion.png`, import.meta.url).pathname,
    });
    if (mobile) await ghost.locator("button").click();
    else { await editor.focus(); await page.keyboard.press("Tab"); }
    await page.waitForFunction((text) => document.querySelector('[data-promptbox-input-region] [contenteditable="true"]')?.textContent === text, suggestion);
    // BB's native touch composer opens the keyboard only on an explicit tap in the editor.
    if (mobile) await editor.tap();
    await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
    assert.equal(await ghost.count(), 0);
    await page.keyboard.type(" Ещё один пункт.");
    assert.match(await editor.innerText(), /Ещё один пункт/);
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    generation++;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ghost.waitFor({ state: "visible", timeout: 20000 });
    await editor.focus();
    await page.keyboard.press("Escape");
    await ghost.waitFor({ state: "detached" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("[data-next-step-anchor]") !== null);
    await page.waitForTimeout(600);
    assert.equal(await ghost.count(), 0, "Dismissal must survive a reload for the same answer");
    generation++;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ghost.waitFor({ state: "visible", timeout: 20000 });
    await editor.focus();
    await page.keyboard.type("Мой запрос");
    assert.equal(await ghost.count(), 0);
    assert.equal((await editor.innerText()).trim(), "Мой запрос");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    assert.deepEqual(errors, [], "No plugin or app crashes");
    console.log(JSON.stringify({ layout: mobile ? "mobile" : "desktop", ok: true, requests, checks: ["ghost", "accept", "edit", "escape", "dismissal persistence", "typing"] }));
    await context.close();
  }
} finally { await browser.close(); }
