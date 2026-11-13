import { createHash } from "node:crypto";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { EMPTY_SUGGESTION, hostContract, rpcContract, type Suggestion } from "./contract";
import { suggestionPrompt } from "./logic";

export { rpcContract } from "./contract";
type Job = { controller: AbortController; result: Promise<Suggestion>; consumers: number };
type CachedSuggestion = Suggestion & { createdAt: number };

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean", label: "Подсказка следующего шага",
      description: "После ответа Codex предлагать одно следующее сообщение. Tab — принять, Esc — скрыть. Использует дополнительный запрос к Codex.",
      default: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const jobs = new Map<string, Job>();
  const lifecycle = new AbortController();

  function cancel(threadId: string) {
    jobs.get(threadId)?.controller.abort();
    jobs.delete(threadId);
  }
  for (const event of ["thread.active", "thread.failed", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => cancel(thread.id));
  }
  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.providerId === "codex") bb.realtime.publish("turn-finished", { threadId: thread.id });
  });
  settings.onChange(({ enabled }) => {
    if (!enabled) for (const threadId of jobs.keys()) cancel(threadId);
  });
  bb.onDispose(() => {
    lifecycle.abort();
    for (const threadId of jobs.keys()) cancel(threadId);
  });

  async function generate(threadId: string, signal: AbortSignal): Promise<Suggestion> {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.providerId !== "codex" || thread.status !== "idle" || thread.archivedAt || !thread.environmentId) return EMPTY_SUGGESTION;
    const [reply, prompts, environment, execution] = await Promise.all([
      bb.sdk.threads.output({ threadId, signal }),
      bb.sdk.threads.promptHistory({ threadId, limit: "3", signal }),
      bb.sdk.environments.get({ environmentId: thread.environmentId, signal }),
      bb.sdk.threads.defaultExecutionOptions({ threadId, signal }),
    ]);
    if (!reply.output?.trim() || !prompts.length) return EMPTY_SUGGESTION;
    const messages = [...prompts].sort((a, b) => a.createdAt - b.createdAt).map((row) =>
      row.input.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    );
    const prompt = suggestionPrompt(messages, reply.output);
    const key = createHash("sha256").update(JSON.stringify({
      prompt, model: execution?.model ?? null, lastPromptId: prompts[0]?.id,
    })).digest("hex").slice(0, 24);
    const cache = await bb.storage.kv.get<CachedSuggestion>(`suggestion:${threadId}`);
    if (cache?.key === key && Date.now() - cache.createdAt < 86400000) return { key, text: cache.text };
    signal.throwIfAborted();
    const result = await host.call("complete", { prompt, model: execution?.model ?? null }, {
      hostId: environment.hostId, signal, timeoutMs: 40000,
    });
    signal.throwIfAborted();
    if (!(await settings.get()).enabled) return EMPTY_SUGGESTION;
    const current = await bb.sdk.threads.get({ threadId, signal });
    if (current.status !== "idle" || current.archivedAt || current.providerId !== "codex") return EMPTY_SUGGESTION;
    const suggestion = { key, text: result.suggestion };
    await bb.storage.kv.set(`suggestion:${threadId}`, { ...suggestion, createdAt: Date.now() });
    return suggestion;
  }

  async function suggest(threadId: string, signal: AbortSignal): Promise<Suggestion> {
    if (!(await settings.get()).enabled || signal.aborted || lifecycle.signal.aborted) return EMPTY_SUGGESTION;
    let job = jobs.get(threadId);
    if (!job) {
      const controller = new AbortController();
      const combined = AbortSignal.any([controller.signal, lifecycle.signal]);
      job = { controller, consumers: 0, result: Promise.resolve(EMPTY_SUGGESTION) };
      const ownJob = job;
      job.result = generate(threadId, combined).catch(() => {
        if (!combined.aborted) bb.log.warn(`Не удалось получить подсказку для ${threadId}. Проверьте авторизацию Codex на машине диалога.`);
        return EMPTY_SUGGESTION;
      }).finally(() => {
        if (jobs.get(threadId) === ownJob) jobs.delete(threadId);
      });
      jobs.set(threadId, job);
    }
    const ownJob = job;
    ownJob.consumers++;
    let release: (() => void) | undefined;
    try {
      return await Promise.race([
        ownJob.result,
        new Promise<Suggestion>((resolve) => {
          release = () => resolve(EMPTY_SUGGESTION);
          signal.addEventListener("abort", release, { once: true });
          if (signal.aborted) release();
        }),
      ]);
    } finally {
      if (release) signal.removeEventListener("abort", release);
      if (--ownJob.consumers === 0) ownJob.controller.abort();
    }
  }

  async function status() { return { enabled: (await settings.get()).enabled, activeRequests: jobs.size }; }
  bb.rpc.register(rpcContract, {
    suggest: ({ threadId }, context) => suggest(threadId, context.experimental_signal), status,
  });
  bb.cli.register(defineCli({
    name: "next-step", summary: "Подсказка следующего сообщения для Codex",
    commands: {
      status: cliCommand({
        summary: "Показать состояние подсказок",
        options: { json: { type: "boolean", description: "JSON" } },
        async run(input) {
          const state = await status();
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(state) :
            `Подсказки: ${state.enabled ? "включены" : "выключены"}. Запросов: ${state.activeRequests}.` };
        },
      }),
      suggest: cliCommand({
        summary: "Получить подсказку для последнего ответа без отправки сообщения",
        options: {
          thread: { type: "string", description: "ID диалога; по умолчанию текущий" },
          json: { type: "boolean", description: "JSON" },
        },
        async run(input, context) {
          const threadId = input.options.thread ?? context.threadId;
          if (!threadId) return { exitCode: 1, stderr: "Укажите --thread <id>." };
          const result = await suggest(threadId, context.signal ?? lifecycle.signal);
          return { exitCode: 0, stdout: input.options.json ? JSON.stringify(result) : result.text ?? "Подсказки нет." };
        },
      }),
    },
  }));
}
