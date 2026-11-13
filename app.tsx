import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp, experimental_usePluginId, useComposer, useRealtime,
  useRealtimeConnectionState, useRpc, useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Suggestion } from "./contract";
import { mountGhost, GHOST_CSS } from "./ghost";

export function NextStep() {
  const composer = useComposer();
  const { values, isLoading } = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const connection = useRealtimeConnectionState();
  const anchor = useRef<HTMLSpanElement>(null);
  const epoch = useRef(0);
  const request = useRef(0);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [revision, setRevision] = useState(0);
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const enabled = !isLoading && values?.enabled !== false && composer.selection?.providerId === "codex";
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useRealtime("turn-finished", (event) => {
    if (event && typeof event === "object" && "threadId" in event && event.threadId === threadId) refresh();
  });
  useEffect(() => {
    epoch.current++;
    setSuggestion(null);
  }, [threadId, composer.isRunning]);
  useEffect(() => {
    if (!composer.isEmpty) epoch.current++;
  }, [composer.text, composer.isEmpty, composer.attachmentCount]);
  useEffect(() => composer.onSubmitted(() => {
    epoch.current++;
    setSuggestion(null);
  }), [composer]);

  useEffect(() => {
    const id = ++request.current;
    if (!enabled || !threadId || composer.isRunning || !composer.isEmpty || document.visibilityState === "hidden") {
      setSuggestion(null);
      return;
    }
    const startedAt = epoch.current;
    let disposed = false;
    const timer = setTimeout(() => {
      rpc.call("suggest", { threadId }).then((result) => {
        if (disposed || id !== request.current || epoch.current !== startedAt || composer.isRunning || !composer.isEmpty) return;
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(`bb-next-step:${threadId}`) === result.key; } catch { /* optional */ }
        setSuggestion(dismissed ? null : result);
      }).catch(() => { if (!disposed) setSuggestion(null); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
    // Draft edits invalidate the result, but never trigger another paid request for the same turn.
  }, [threadId, enabled, composer.isRunning, revision, connection, rpc, composer]);

  useEffect(() => {
    const visibilityChanged = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => document.removeEventListener("visibilitychange", visibilityChanged);
  }, [refresh]);

  useEffect(() => {
    if (!anchor.current || !enabled || !threadId || !suggestion?.text || !suggestion.key || composer.isRunning || composer.isSubmitting || !composer.isEmpty) return;
    return mountGhost(anchor.current, composer, suggestion.text, pluginId, () => {
      epoch.current++;
      try { sessionStorage.setItem(`bb-next-step:${threadId}`, suggestion.key!); } catch { /* optional */ }
      setSuggestion(null);
    });
  }, [suggestion, enabled, threadId, composer.isRunning, composer.isSubmitting, composer.isEmpty, composer.layout, composer, pluginId]);

  return <span ref={anchor} data-next-step-anchor="" aria-hidden="true" style={{ display: "none" }} />;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "ghost-styles",
    mount() {
      const style = document.createElement("style");
      style.textContent = GHOST_CSS;
      document.head.append(style);
      return () => style.remove();
    },
  });
  app.composer.customize({
    id: "next-step", scopes: ["thread"],
    banners: [{ id: "suggestion", chrome: "bare", component: NextStep }],
  });
});
