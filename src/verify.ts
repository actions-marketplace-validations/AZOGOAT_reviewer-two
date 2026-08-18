import type { makeExploreTools } from "./explore.js";
import { addUsage, runStructured, type UsageBreakdown } from "./model.js";
import { buildVerifyPrompt } from "./prompts.js";
import { type Finding, severities, verificationSchema } from "./schema.js";

const VERIFY_TOOL_CALLS = 10;
const MAX_VERIFIED_FINDINGS = 20;

/**
 * Phase 2: re-examines each candidate finding with fresh tool access and keeps
 * only findings the model confirms with concrete evidence. On a call failure
 * the finding is kept; verification filters noise, it must not lose findings.
 * At most MAX_VERIFIED_FINDINGS are verified, most severe first, so a noisy
 * phase 1 cannot run the job into its timeout; the overflow is dropped and
 * counted in skipped, never posted unverified.
 * Discarded findings come back with the model's evidence, for the run log.
 * usage sums the phase's calls; a failed call contributes nothing.
 */
export async function verifyFindings(opts: {
  modelId: string;
  system: string;
  findings: Finding[];
  tools: ReturnType<typeof makeExploreTools>;
  contextWindowTokens: number;
}): Promise<{
  findings: Finding[];
  discarded: { finding: Finding; evidence: string }[];
  usage: UsageBreakdown;
  skipped: number;
}> {
  const confirmed: Finding[] = [];
  const discarded: { finding: Finding; evidence: string }[] = [];
  let usage: UsageBreakdown = {
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  const selected = [...opts.findings]
    .sort(
      (a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity),
    )
    .slice(0, MAX_VERIFIED_FINDINGS);
  for (const finding of selected) {
    try {
      const { output, usage: callUsage } = await runStructured({
        modelId: opts.modelId,
        system: opts.system,
        prompt: buildVerifyPrompt(finding),
        schema: verificationSchema,
        tools: opts.tools,
        maxToolCalls: VERIFY_TOOL_CALLS,
        contextWindowTokens: opts.contextWindowTokens,
      });
      usage = addUsage(usage, callUsage);
      if (output.verdict === "confirmed") {
        confirmed.push({
          ...finding,
          severity: output.severity ?? finding.severity,
        });
      } else {
        discarded.push({ finding, evidence: output.evidence });
      }
    } catch {
      confirmed.push(finding);
    }
  }
  return {
    findings: confirmed,
    discarded,
    usage,
    skipped: opts.findings.length - selected.length,
  };
}
