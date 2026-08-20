import type { PreviousThread } from "./context.js";
import type { makeExploreTools } from "./explore.js";
import { addUsage, runStructured, type UsageBreakdown } from "./model.js";
import { buildVerifyPreamble, buildVerifyPrompt } from "./prompts.js";
import {
  type Finding,
  type Severity,
  severities,
  verificationSchema,
} from "./schema.js";

const VERIFY_TOOL_CALLS = 10;
const MAX_VERIFIED_FINDINGS = 20;

/**
 * Phase 2: re-examines each candidate finding with fresh tool access and keeps
 * the ones the model confirms with concrete evidence. Verifies at most
 * MAX_VERIFIED_FINDINGS, most severe first; the overflow is counted in skipped.
 * Findings that restate an earlier thread come back in duplicates. On a call
 * failure the finding is kept; verification filters noise, it must not lose
 * findings. discarded and duplicates carry the model's evidence for the log.
 */
export async function verifyFindings(opts: {
  modelId: string;
  system: string;
  findings: Finding[];
  previous: PreviousThread[];
  requestChangesThreshold: Severity;
  tools: ReturnType<typeof makeExploreTools>;
  contextWindowTokens: number;
}): Promise<{
  findings: Finding[];
  discarded: { finding: Finding; evidence: string }[];
  duplicates: { finding: Finding; evidence: string }[];
  usage: UsageBreakdown;
  skipped: number;
}> {
  const confirmed: Finding[] = [];
  const discarded: { finding: Finding; evidence: string }[] = [];
  const duplicates: { finding: Finding; evidence: string }[] = [];
  let usage: UsageBreakdown = {
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  const reReview = opts.previous.length > 0;
  const preamble = buildVerifyPreamble(
    opts.previous,
    opts.requestChangesThreshold,
  );
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
        prompt: [preamble, buildVerifyPrompt(finding)],
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
      } else if (output.verdict === "duplicate" && reReview) {
        duplicates.push({ finding, evidence: output.evidence });
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
    duplicates,
    usage,
    skipped: opts.findings.length - selected.length,
  };
}
