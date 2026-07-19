import type { makeExploreTools } from "./explore.js";
import { runStructured } from "./model.js";
import { buildVerifyPrompt } from "./prompts.js";
import { type Finding, verificationSchema } from "./schema.js";

const DEFAULT_VERIFY_TOOL_CALLS = 10;

/**
 * Phase 2: re-examines each candidate finding with fresh tool access and keeps
 * only findings the model confirms with concrete evidence. On a call failure
 * the finding is kept; verification filters noise, it must not lose findings.
 */
export async function verifyFindings(opts: {
  modelId: string;
  system: string;
  findings: Finding[];
  tools: ReturnType<typeof makeExploreTools>;
  maxToolCallsPerFinding?: number;
}): Promise<Finding[]> {
  const confirmed: Finding[] = [];
  for (const finding of opts.findings) {
    try {
      const { output } = await runStructured({
        modelId: opts.modelId,
        system: opts.system,
        prompt: buildVerifyPrompt(finding),
        schema: verificationSchema,
        tools: opts.tools,
        maxToolCalls: opts.maxToolCallsPerFinding ?? DEFAULT_VERIFY_TOOL_CALLS,
      });
      if (output.verdict === "confirmed") confirmed.push(finding);
    } catch {
      confirmed.push(finding);
    }
  }
  return confirmed;
}
