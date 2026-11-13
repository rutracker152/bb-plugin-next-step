import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";

export const GHOST_CSS = `
[data-next-step-visible] .is-editor-empty::before,
[data-next-step-visible] [data-placeholder]::before,
[data-next-step-visible] [placeholder]::before { content: none !important; }
[data-next-step-ghost] { position: absolute; z-index: 1; pointer-events: none; overflow: hidden; }
[data-next-step-ghost] button {
  display: flex; align-items: baseline; gap: 0.65em; width: 100%; min-width: 0;
  margin: 0; padding: 0; border: 0; background: transparent; color: var(--muted-foreground);
  font: inherit; line-height: inherit; text-align: left; cursor: pointer; pointer-events: auto;
}
[data-next-step-ghost] .next-step-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; }
[data-next-step-ghost] .next-step-key {
  flex: none; border: 1px solid var(--border); border-radius: 4px; padding: 0 4px;
  font-size: 0.75em; line-height: 1.5; opacity: 0.75;
}
[data-next-step-ghost] button:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
`;

function findEditor(anchor: HTMLElement) {
  for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const regions = parent.querySelectorAll<HTMLElement>("[data-promptbox-input-region]");
    if (regions.length > 1) return null;
    const region = regions[0];
    const editor = region?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (region && editor) return { region, editor, root: parent };
  }
  return null;
}

/** DOM enhancement of BB's bundled Composer. Draft writes use the public SDK. */
export function mountGhost(
  anchor: HTMLElement, composer: PluginComposerApi, text: string, pluginId: string, dismiss: () => void,
): () => void {
  const found = findEditor(anchor);
  if (!found) return () => {};
  const { root, region, editor } = found;
  const overlay = document.createElement("div");
  overlay.dataset.nextStepGhost = "";
  overlay.dataset.bbPlugin = pluginId;
  overlay.dataset.bbPluginRoot = pluginId;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Tab — принять подсказку · Esc — скрыть";
  button.setAttribute("aria-label", `Принять подсказку: ${text}`);
  const label = document.createElement("span");
  label.className = "next-step-text";
  label.textContent = text;
  const key = document.createElement("span");
  key.className = "next-step-key";
  key.textContent = window.matchMedia?.("(pointer: coarse)").matches ? "Вставить" : "Tab";
  key.setAttribute("aria-hidden", "true");
  button.append(label, key);
  overlay.append(button);
  region.append(overlay);
  let disposed = false;

  const canUse = () => !disposed && composer.isEmpty && !composer.isRunning && !composer.isSubmitting &&
    composer.selection?.providerId === "codex" && editor.isConnected && editor.isContentEditable !== false &&
    !editor.textContent?.trim() && !region.closest('[aria-hidden="true"], [inert]') &&
    !root.querySelector('[data-promptbox-typeahead-menu]');

  function position() {
    if (disposed) return;
    const visible = canUse();
    overlay.hidden = !visible;
    editor.toggleAttribute("data-next-step-visible", visible);
    if (!visible) return;
    const container = region.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const rect = (editor.querySelector("p") ?? editor).getBoundingClientRect();
    const computed = getComputedStyle(editor);
    const scroll = editor.closest<HTMLElement>("[data-promptbox-editor-scroll]") ?? region;
    const scrollRight = scroll.getBoundingClientRect().right;
    const rightPadding = Number.parseFloat(getComputedStyle(scroll).paddingRight) || 0;
    overlay.style.left = `${rect.left - container.left}px`;
    overlay.style.top = `${editorRect.top - container.top}px`;
    // Compact Composer uses an empty inline paragraph whose own width is zero.
    overlay.style.width = `${Math.max(0, Math.min(container.right, scrollRight) - rightPadding - rect.left)}px`;
    overlay.style.fontFamily = computed.fontFamily;
    overlay.style.fontSize = computed.fontSize;
    overlay.style.lineHeight = computed.lineHeight;
    overlay.style.letterSpacing = computed.letterSpacing;
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    resize?.disconnect();
    root.removeEventListener("keydown", onKey, true);
    root.removeEventListener("beforeinput", onInput, true);
    root.removeEventListener("compositionstart", onInput, true);
    window.removeEventListener("resize", position);
    editor.removeAttribute("data-next-step-visible");
    overlay.remove();
  }
  function hide() { cleanup(); dismiss(); }
  function accept() {
    if (!canUse()) return;
    let inserted = false;
    composer.replace((draft) => {
      if (draft.text.trim() || draft.mentions.length || draft.attachments.length) return draft;
      inserted = true;
      return { text, mentions: [] };
    });
    if (inserted) { hide(); composer.focus(); }
  }
  function onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        !(event.target instanceof Node) || !editor.contains(event.target) || !canUse()) return;
    if (event.key === "Tab") {
      event.preventDefault(); event.stopPropagation(); accept();
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); hide();
    }
  }
  function onInput(event: Event) {
    if (event.target instanceof Node && editor.contains(event.target)) hide();
  }
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", accept);
  root.addEventListener("keydown", onKey, true);
  root.addEventListener("beforeinput", onInput, true);
  root.addEventListener("compositionstart", onInput, true);
  const observer = new MutationObserver((changes) => {
    if (changes.every((change) => overlay.contains(change.target) || change.target === overlay)) return;
    position();
  });
  observer.observe(root, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["aria-hidden", "inert", "contenteditable"],
  });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
  resize?.observe(region);
  resize?.observe(editor);
  window.addEventListener("resize", position);
  position();
  return cleanup;
}
