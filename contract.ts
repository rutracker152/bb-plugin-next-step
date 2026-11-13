import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const suggestionSchema = z.object({
  suggestion: z.string().trim().min(1).max(180).nullable(),
}).strict();

export const rpcContract = defineRpcContract({
  suggest: {
    experimental_description: "Suggest one next user message for a completed Codex turn. Never sends it.",
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ key: z.string().nullable(), text: z.string().nullable() }).strict(),
  },
  status: {
    input: z.null(),
    output: z.object({ enabled: z.boolean(), activeRequests: z.number().int() }).strict(),
  },
});

export const hostContract = defineRpcContract({
  complete: {
    input: z.object({
      prompt: z.string().min(1).max(16000),
      model: z.string().max(200).nullable(),
    }).strict(),
    output: suggestionSchema,
  },
});

export type Suggestion = { key: string | null; text: string | null };
export const EMPTY_SUGGESTION: Suggestion = { key: null, text: null };
