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
 * Findings that restate an earlier thread come back in duplicates. A failed
 * call keeps the finding on a first review and returns it in unverified on a
 * re-review. discarded and duplicates carry the model's evidence for the log.
 * A suggestion block survives only when the model rules keep on it: the finding
 * keeps its comment either way and comes back in droppedSuggestions for the log.
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
  unverified: Finding[];
  droppedSuggestions: Finding[];
  usage: UsageBreakdown;
  skipped: number;
}> {
  const confirmed: Finding[] = [];
  const discarded: { finding: Finding; evidence: string }[] = [];
  const duplicates: { finding: Finding; evidence: string }[] = [];
  const unverified: Finding[] = [];
  const droppedSuggestions: Finding[] = [];
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
        const keeps = output.suggestion === "keep";
        if (finding.suggestion && !keeps) droppedSuggestions.push(finding);
        confirmed.push({
          ...finding,
          severity: output.severity ?? finding.severity,
          suggestion: keeps ? finding.suggestion : undefined,
        });
      } else if (output.verdict === "duplicate" && reReview) {
        duplicates.push({ finding, evidence: output.evidence });
      } else {
        discarded.push({ finding, evidence: output.evidence });
      }
    } catch {
      if (reReview) {
        unverified.push(finding);
      } else {
        if (finding.suggestion) droppedSuggestions.push(finding);
        confirmed.push({ ...finding, suggestion: undefined });
      }
    }
  }
  return {
    findings: confirmed,
    discarded,
    duplicates,
    unverified,
    droppedSuggestions,
    usage,
    skipped: opts.findings.length - selected.length,
  };
}
