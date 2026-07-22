import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, isStepCount, Output, tool } from "ai";
import type { z } from "zod";

export { tool as defineTool };

const DEFAULT_MAX_TOOL_CALLS = 50;

/** Maps a plain model id string to a provider model instance. */
export function resolveModel(id: string) {
  if (id.startsWith("claude-")) return anthropic(id);
  if (id.startsWith("gpt-") || /^o\d/.test(id)) return openai(id);
  throw new Error(
    `Unsupported model "${id}". Use a claude-* id (Anthropic) or a gpt-*/o* id (OpenAI).`,
  );
}

interface UsageStep {
  usage: { totalTokens?: number };
}

/**
 * Stop condition on accumulated token usage across steps. A guard against
 * runaway loops, not a depth limiter; undefined budget never stops.
 */
export function exceedsTokenBudget(budget?: number) {
  return ({ steps }: { steps: UsageStep[] }) => {
    if (budget === undefined) return false;
    const used = steps.reduce((n, s) => n + (s.usage.totalTokens ?? 0), 0);
    return used >= budget;
  };
}

export interface AgenticCallOptions<T> {
  modelId: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tools?: Parameters<typeof generateText>[0]["tools"];
  maxToolCalls?: number;
  tokenBudget?: number;
}

/**
 * One agentic call with structured output. Used by phase 1 (with generous
 * budgets) and phase 2 (with small ones). The system message carries an
 * Anthropic cache breakpoint; OpenAI models ignore that provider option.
 */
export async function runStructured<T>(
  opts: AgenticCallOptions<T>,
): Promise<{ output: T; toolCalls: number }> {
  const result = await generateText({
    model: resolveModel(opts.modelId),
    temperature: 0.2,
    instructions: {
      role: "system",
      content: opts.system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    messages: [{ role: "user", content: opts.prompt }],
    tools: opts.tools,
    // step count approximates tool calls; a step may batch parallel calls
    stopWhen: [
      isStepCount(opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
      exceedsTokenBudget(opts.tokenBudget),
    ],
    output: Output.object({ schema: opts.schema }),
  });
  const toolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  return { output: opts.schema.parse(result.output), toolCalls };
}
