---
name: next-step
description: Inspect or troubleshoot the optional next-message suggestions in BB's Codex composer.
---

# Подсказка следующего шага

This plugin shows one optional suggested next message in an empty BB composer after a Codex reply.
Tab accepts the text for editing; Esc dismisses it for that reply. A click also accepts it on touch devices.
The plugin never sends messages automatically. Continue writing ordinary final replies; no special output format or tool call is required from the main agent.

- `bb next-step status [--json]` reports whether suggestions are enabled and how many requests are running.
- `bb next-step suggest [--thread <thread-id>] [--json]` obtains the latest suggestion without sending a message. This can make a Codex request.
- `bb plugin config next-step set enabled false` disables suggestions; `true` enables them. The same toggle is in the plugin's settings.
- `bb plugin logs next-step -n 20` reports optional generation failures without logging conversation content.

Generation uses the installed `codex exec` and its existing authorization on the thread's machine. It runs in a temporary directory with shell, web search and subagents disabled, does not resume the user's session, and expires after 35 seconds. No additional API key is required. Results are cached per answer for 24 hours. Codex may return no suggestion when no useful follow-up exists.

The frontend decorates the bundled BB Composer using its `data-promptbox-*` markers and writes accepted text through the public composer SDK. After a BB update, if the hint disappears, check those markers and rerun the browser smoke check before changing the native composer.
