import type { makeExploreTools } from "./explore.js";
import { runStructured, type UsageBreakdown } from "./model.js";
import { buildVerifyPrompt } from "./prompts.js";
import { type Finding, verificationSchema } from "./schema.js";

const DEFAULT_VERIFY_TOOL_CALLS = 10;

/**
 * Phase 2: re-examines each candidate finding with fresh tool access and keeps
 * only findings the model confirms with concrete evidence. On a call failure
 * the finding is kept; verification filters noise, it must not lose findings.
 * usage sums the phase's calls; a failed call contributes nothing.
 */
export async function verifyFindings(opts: {
  modelId: string;
  system: string;
  findings: Finding[];
  tools: ReturnType<typeof makeExploreTools>;
  maxToolCallsPerFinding?: number;
}): Promise<{ findings: Finding[]; usage: UsageBreakdown }> {
  const confirmed: Finding[] = [];
  const usage: UsageBreakdown = {
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  for (const finding of opts.findings) {
    try {
      const { output, usage: callUsage } = await runStructured({
        modelId: opts.modelId,
        system: opts.system,
        prompt: buildVerifyPrompt(finding),
        schema: verificationSchema,
        tools: opts.tools,
        maxToolCalls: opts.maxToolCallsPerFinding ?? DEFAULT_VERIFY_TOOL_CALLS,
      });
      usage.noCache += callUsage.noCache;
      usage.cacheRead += callUsage.cacheRead;
      usage.cacheWrite += callUsage.cacheWrite;
      usage.output += callUsage.output;
      if (output.verdict === "confirmed") {
        confirmed.push({
          ...finding,
          severity: output.severity ?? finding.severity,
        });
      }
    } catch {
      confirmed.push(finding);
    }
  }
  return { findings: confirmed, usage };
}
