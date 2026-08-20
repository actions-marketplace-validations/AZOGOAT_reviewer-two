import type { FileDiff, Octokit, PreviousThread, PrRef } from "./context.js";
import {
  type Finding,
  type ReviewOutput,
  type Severity,
  severities,
} from "./schema.js";

const RANKS: Record<Severity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  nit: 0,
};

/** Numeric severity order, critical highest. */
export function severityRank(s: Severity): number {
  return RANKS[s];
}

/** True when severity s is at or above the threshold. */
export function meetsThreshold(s: Severity, threshold: Severity): boolean {
  return RANKS[s] >= RANKS[threshold];
}

const TRAILER = new RegExp(`^_(${severities.join("|")}) \\| (.+)_$`, "gm");

/** Reads severity and ruleRef back from a body written by renderFindingBody. */
export function parseFindingTrailer(
  body: string,
): { severity: Severity; ruleRef: string } | null {
  const last = [...body.matchAll(TRAILER)].at(-1);
  if (!last) return null;
  return { severity: last[1] as Severity, ruleRef: last[2] as string };
}

export type ThreadStatus = "open" | "closed";

/** open: nobody replied or resolved it and the finding meets the request-changes threshold. closed: anything else. */
export function threadStatus(
  thread: PreviousThread,
  requestChangesThreshold: Severity,
): ThreadStatus {
  if (thread.resolved || thread.replies.length > 0) return "closed";
  const trailer = parseFindingTrailer(thread.body);
  if (!trailer) return "closed";
  return meetsThreshold(trailer.severity, requestChangesThreshold)
    ? "open"
    : "closed";
}

/** Splits findings on whether a closed earlier thread sits at their path and line. */
export function dedupeAgainstPrevious(
  findings: Finding[],
  previous: PreviousThread[],
  requestChangesThreshold: Severity,
): { fresh: Finding[]; sameLine: Finding[] } {
  const seen = new Set(
    previous
      .filter(
        (p) =>
          p.line !== null &&
          threadStatus(p, requestChangesThreshold) === "closed",
      )
      .map((p) => `${p.path}:${p.line}`),
  );
  const fresh: Finding[] = [];
  const sameLine: Finding[] = [];
  for (const f of findings) {
    if (seen.has(`${f.path}:${f.line}`)) sameLine.push(f);
    else fresh.push(f);
  }
  return { fresh, sameLine };
}

export interface ReviewPlan {
  event: "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

/** Blank or fenced text cannot render as a suggestion block, so it is dropped. */
function usableSuggestion(suggestion: string | undefined): string | undefined {
  if (!suggestion || suggestion.trim() === "") return undefined;
  return suggestion.includes("```") ? undefined : suggestion;
}

function renderFindingBody(f: Finding): string {
  const usable = usableSuggestion(f.suggestion);
  const suggestion = usable ? `\n\n\`\`\`suggestion\n${usable}\n\`\`\`` : "";
  return `${f.comment}\n\n_${f.severity} | ${f.ruleRef}_${suggestion}`;
}

function renderBodyLine(f: Finding): string {
  return `- \`${f.path}:${f.line}\` (${f.severity}, ${f.ruleRef}) ${f.comment}`;
}

/** Closing body line: files covered, tool calls, repeats dropped. */
function renderFootnote(
  reviewedFiles: number,
  totalFiles: number,
  stats: { toolCalls: number; duplicates: number },
): string {
  const files = `${reviewedFiles} of ${totalFiles} changed ${totalFiles === 1 ? "file" : "files"}`;
  const repeats =
    stats.duplicates === 0
      ? ""
      : stats.duplicates === 1
        ? "; dropped 1 repeat of an earlier thread"
        : `; dropped ${stats.duplicates} repeats of earlier threads`;
  return `_Reviewed ${files} with ${stats.toolCalls} tool calls${repeats}._`;
}

/** Collapsed section listing what verification threw out, and why. */
function renderDiscardedSection(
  discarded: { finding: Finding; evidence: string }[],
): string {
  return [
    "<details>",
    `<summary>Discarded by verification (${discarded.length})</summary>`,
    "",
    ...discarded.map(
      (d) =>
        `${renderBodyLine(d.finding)}\n  _Discarded: ${d.evidence.replace(/\s*\n\s*/g, " ")}_`,
    ),
    "",
    "</details>",
  ].join("\n");
}

/**
 * Turns verified findings into one review: inline comments for anchored
 * findings above the threshold (capped, highest severity first), everything
 * else collapsed into the body. Nothing is dropped.
 */
export function planReview(
  output: ReviewOutput,
  files: FileDiff[],
  opts: {
    maxInlineComments: number;
    inlineSeverityThreshold: Severity;
    requestChangesThreshold: Severity;
    skippedFiles: string[];
    stats: { toolCalls: number; duplicates: number };
    discarded: { finding: Finding; evidence: string }[];
    unverified: number;
  },
): ReviewPlan {
  const anchorable = new Map(files.map((f) => [f.path, f.commentableLines]));
  const inlineEligible: Finding[] = [];
  const bodyFindings: Finding[] = [];

  for (const f of output.findings) {
    const anchored = anchorable.get(f.path)?.has(f.line) ?? false;
    const aboveThreshold =
      f.severity !== "nit" &&
      meetsThreshold(f.severity, opts.inlineSeverityThreshold);
    if (anchored && aboveThreshold) inlineEligible.push(f);
    else bodyFindings.push(f);
  }

  const bySeverity = [...inlineEligible].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const inline = bySeverity.slice(0, opts.maxInlineComments);
  const overflow = bySeverity.slice(opts.maxInlineComments);
  bodyFindings.push(...overflow);

  const bodyParts = [output.summary];
  if (bodyFindings.length > 0) {
    bodyParts.push(
      [
        "<details>",
        `<summary>Additional findings (${bodyFindings.length})</summary>`,
        "",
        ...bodyFindings.map(renderBodyLine),
        "",
        "</details>",
      ].join("\n"),
    );
  }
  if (opts.discarded.length > 0) {
    bodyParts.push(renderDiscardedSection(opts.discarded));
  }
  if (opts.skippedFiles.length > 0) {
    bodyParts.push(
      `Note: these files were too large to include in the review context and were only explored on demand: ${opts.skippedFiles.map((f) => `\`${f}\``).join(", ")}.`,
    );
  }
  if (opts.unverified > 0) {
    const n = opts.unverified;
    bodyParts.push(
      `Note: ${n} ${n === 1 ? "finding" : "findings"} could not be checked because the verification call failed, so ${n === 1 ? "it is" : "they are"} left out of this review.`,
    );
  }
  bodyParts.push(
    renderFootnote(
      files.length,
      files.length + opts.skippedFiles.length,
      opts.stats,
    ),
  );

  const event = output.findings.some((f) =>
    meetsThreshold(f.severity, opts.requestChangesThreshold),
  )
    ? ("REQUEST_CHANGES" as const)
    : ("COMMENT" as const);

  return {
    event,
    body: bodyParts.join("\n\n"),
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT" as const,
      body: renderFindingBody(f),
    })),
  };
}

/** Submits the review. Aside from main.ts's failure comment, pulls.createReview is the only write this tool performs. */
export async function submitReview(
  octokit: Octokit,
  ref: PrRef,
  plan: ReviewPlan,
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pullNumber,
    event: plan.event,
    body: plan.body,
    comments: plan.comments,
  });
}
