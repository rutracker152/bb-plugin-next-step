// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { NextStep } from "./app";

function ComposerFixture() {
  return <div data-fixture-composer="">
    <NextStep />
    <div data-promptbox-input-region="">
      <div contentEditable suppressContentEditableWarning data-testid="editor"><p><br /></p></div>
    </div>
  </div>;
}

const slots: RenderedSlot[] = [];
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { slots.splice(0).forEach((slot) => slot.lifecycle.unmount()); document.body.innerHTML = ""; });

function setup(options: { text?: string; enabled?: boolean; isRunning?: boolean; attachmentCount?: number; suggest?: () => Promise<{ key: string; text: string }> } = {}) {
  const suggest = vi.fn(options.suggest ?? (async () => ({ key: "answer-1", text: "Добавь переключатель в настройках." })));
  const slot = renderSlot({ component: ComposerFixture }, {}, {
    pluginId: "next-step", settings: { enabled: options.enabled ?? true },
    context: { threadId: "thread-test" }, rpc: { suggest },
    composer: {
      scope: { kind: "thread", threadId: "thread-test" },
      selection: { providerId: "codex" }, text: options.text,
      isRunning: options.isRunning, attachmentCount: options.attachmentCount,
    },
  });
  slots.push(slot);
  return { slot, suggest, editor: slot.getByTestId("editor") };
}

describe("composer suggestion", () => {
  it("registers only a thread customization and removes styles on unload", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.composerCustomizations[0]?.scopes).toEqual(["thread"]);
    const count = document.head.querySelectorAll("style").length;
    const scripts = await mountPluginContentScripts(app, { pluginId: "next-step", generation: 1 });
    expect(document.head.querySelectorAll("style")).toHaveLength(count + 1);
    await scripts.lifecycle.dispose();
    expect(document.head.querySelectorAll("style")).toHaveLength(count);
  });

  it("Tab accepts into the editable draft and never submits", async () => {
    const { slot, editor } = setup();
    await slot.findByRole("button", { name: /Принять подсказку/ });
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { editor.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(slot.inspection.composer.text).toBe("Добавь переключатель в настройках.");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    expect(slot.inspection.composer.focusCount).toBeGreaterThanOrEqual(1);
    expect(slot.queryByRole("button")).toBeNull();
    await slot.behavior.setComposerText("Отредактированная подсказка");
    expect(slot.inspection.composer.text).toBe("Отредактированная подсказка");
  });

  it("Esc dismisses the hint for that answer, including after a reconnect", async () => {
    const { slot, editor } = setup();
    await slot.findByRole("button");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.inspection.composer.text).toBe("");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(slot.queryByRole("button")).toBeNull();
  });

  it("typing hides the hint and keeps the user's text", async () => {
    const { slot, editor } = setup();
    await slot.findByRole("button");
    fireEvent(editor, new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "М" }));
    await slot.behavior.setComposerText("Мой собственный запрос");
    expect(slot.queryByRole("button")).toBeNull();
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(slot.inspection.composer.text).toBe("Мой собственный запрос");
  });

  it("uses the available composer width when the mobile paragraph has zero width", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-promptbox-input-region") ? new DOMRect(0, 0, 300, 48) : new DOMRect(16, 12, 0, 24);
    });
    try {
      const { slot } = setup();
      await slot.findByRole("button");
      expect((slot.container.querySelector("[data-next-step-ghost]") as HTMLElement).style.width).toBe("284px");
    } finally { bounds.mockRestore(); }
  });

  it("Shift+Tab, composing text and Enter keep their native behavior", async () => {
    const { slot, editor } = setup();
    await slot.findByRole("button");
    for (const options of [{ key: "Tab", shiftKey: true }, { key: "Tab", isComposing: true }, { key: "Enter" }]) {
      const event = new KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true });
      act(() => { editor.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(slot.inspection.composer.text).toBe("");
    expect(slot.inspection.composer.submits).toHaveLength(0);
  });

  it.each([{ text: "Уже написано" }, { isRunning: true }, { enabled: false }, { attachmentCount: 1 }])(
    "never requests a hint for a blocked draft: %j", async (options) => {
      const { slot, suggest } = setup(options);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(suggest).not.toHaveBeenCalled();
      expect(slot.queryByRole("button")).toBeNull();
    },
  );

  it("ignores a late result after typing, and after switching threads", async () => {
    let finish!: (value: { key: string; text: string }) => void;
    const { slot, suggest } = setup({ suggest: () => new Promise((resolve) => { finish = resolve; }) });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    await slot.behavior.setComposerText("Мой черновик");
    await act(async () => { finish({ key: "old", text: "Поздняя подсказка" }); });
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.inspection.composer.text).toBe("Мой черновик");
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "other-thread" });
    expect(slot.queryByRole("button")).toBeNull();
  });
});
