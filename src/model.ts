import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import {
  generateText,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  Output,
  tool,
} from "ai";
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

// Leaves headroom under the model's ~200k window for the wrap-up step.
const CONTEXT_WRAP_UP_TOKENS = 150_000;

/**
 * True when the next step must stop exploring and write the review: the step
 * cap, the token budget, or the context window is nearly full (last step's
 * total tokens stand in for context size). Called from prepareStep.
 */
export function shouldWrapUp(opts: {
  stepNumber: number;
  steps: UsageStep[];
  maxToolCalls: number;
  tokenBudget?: number;
}): boolean {
  if (opts.stepNumber >= opts.maxToolCalls - 1) return true;
  if (exceedsTokenBudget(opts.tokenBudget)({ steps: opts.steps })) return true;
  const last = opts.steps[opts.steps.length - 1];
  return (last?.usage.totalTokens ?? 0) >= CONTEXT_WRAP_UP_TOKENS;
}

/**
 * Stamps Anthropic cache breakpoints on the first message (the PR context)
 * and the last two messages, clearing markers left at earlier positions.
 * With the system breakpoint that is four total, Anthropic's limit; the
 * moving pair keeps each step's prefix a cache hit as the history grows.
 */
export function placeCacheBreakpoints(
  messages: ModelMessage[],
): ModelMessage[] {
  const last = messages.length - 1;
  return messages.map((message, i) => {
    const marked = i === 0 || i >= last - 1;
    if (!marked && message.providerOptions?.anthropic === undefined) {
      return message;
    }
    const providerOptions = { ...message.providerOptions };
    const anthropic = {
      ...(providerOptions.anthropic as Record<string, unknown> | undefined),
    };
    if (marked) anthropic.cacheControl = { type: "ephemeral" };
    else delete anthropic.cacheControl;
    if (Object.keys(anthropic).length > 0) {
      providerOptions.anthropic = anthropic as never;
    } else {
      delete providerOptions.anthropic;
    }
    if (Object.keys(providerOptions).length === 0) {
      const { providerOptions: _dropped, ...rest } = message;
      return rest as ModelMessage;
    }
    return { ...message, providerOptions };
  });
}

/**
 * Fails a run that ended without a review, naming the finish reason and token
 * usage. The SDK on its own surfaces only a bare "No output generated.".
 */
export function assertFinished(result: {
  finishReason: string;
  steps: unknown[];
  totalUsage: { totalTokens?: number };
}): void {
  if (result.finishReason === "stop") return;
  throw new Error(
    `The model stopped without producing the review output ` +
      `(finish reason "${result.finishReason}", ${result.steps.length} steps, ` +
      `${result.totalUsage.totalTokens ?? "unknown"} total tokens).`,
  );
}

/** Token counts by price class, for spotting broken caching in run logs. */
export interface UsageBreakdown {
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface TotalUsage {
  inputTokenDetails: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokens?: number;
}

function toUsageBreakdown(totalUsage: TotalUsage): UsageBreakdown {
  const input = totalUsage.inputTokenDetails;
  return {
    noCache: input.noCacheTokens ?? 0,
    cacheRead: input.cacheReadTokens ?? 0,
    cacheWrite: input.cacheWriteTokens ?? 0,
    output: totalUsage.outputTokens ?? 0,
  };
}

export interface AgenticCallOptions<T> {
  modelId: string | LanguageModel;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tools?: Parameters<typeof generateText>[0]["tools"];
  maxToolCalls?: number;
  tokenBudget?: number;
}

/**
 * One agentic call with structured output. Used by phase 1 (with generous
 * budgets) and phase 2 (with small ones). The system message and, per step,
 * the prompt and latest messages carry Anthropic cache breakpoints; OpenAI
 * models ignore that provider option.
 */
export async function runStructured<T>(
  opts: AgenticCallOptions<T>,
): Promise<{ output: T; toolCalls: number; usage: UsageBreakdown }> {
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const result = await generateText({
    model:
      typeof opts.modelId === "string"
        ? resolveModel(opts.modelId)
        : opts.modelId,
    providerOptions: { anthropic: { structuredOutputMode: "jsonTool" } },
    instructions: {
      role: "system",
      content: opts.system,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    messages: [{ role: "user", content: opts.prompt }],
    tools: opts.tools,
    // prepareStep re-stamps cache breakpoints every step, and forces a final
    // review-only step (exploration tools hidden) when a limit is hit;
    // stopWhen is only a backstop one step further out
    prepareStep: ({ stepNumber, steps, messages }) => ({
      messages: placeCacheBreakpoints(messages),
      ...(shouldWrapUp({
        stepNumber,
        steps,
        maxToolCalls,
        tokenBudget: opts.tokenBudget,
      })
        ? { activeTools: [] }
        : {}),
    }),
    stopWhen: isStepCount(maxToolCalls + 1),
    output: Output.object({ schema: opts.schema }),
  });
  assertFinished(result);
  const toolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  return {
    output: opts.schema.parse(result.output),
    toolCalls,
    usage: toUsageBreakdown(result.usage),
  };
}
