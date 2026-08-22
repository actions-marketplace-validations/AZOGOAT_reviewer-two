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
  const last = [...stripSuggestionBlock(body).matchAll(TRAILER)].at(-1);
  if (!last) return null;
  return { severity: last[1] as Severity, ruleRef: last[2] as string };
}

/** Removes the suggestion block renderFindingBody appends, leaving the comment and trailer. */
export function stripSuggestionBlock(body: string): string {
  return body.replace(/\n*^`{3,}suggestion\n[\s\S]*$/m, "");
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

export interface ReviewPlan {
  event: "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: {
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  }[];
  /** Findings whose declared range could not be anchored, posted on their last line only. */
  droppedRanges: Finding[];
}

function renderFindingBody(f: Finding): string {
  const usable = f.suggestion?.trim() ? f.suggestion : undefined;
  // the outer fence must be longer than any backtick run inside the block
  let fence = "```";
  while (usable?.includes(fence)) fence += "`";
  const suggestion = usable
    ? `\n\n${fence}suggestion\n${usable}\n${fence}`
    : "";
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

  const rangeStart = (f: Finding): number | undefined =>
    f.startLine === f.line ? undefined : f.startLine;
  const rangeUsable = (f: Finding): boolean => {
    const start = rangeStart(f);
    if (start === undefined) return true;
    if (start > f.line) return false;
    const lines = anchorable.get(f.path);
    if (!lines) return false;
    for (let n = start; n <= f.line; n++) {
      if (!lines.has(n)) return false;
    }
    return true;
  };

  const droppedRanges: Finding[] = [];
  const comments = inline.map((f) => {
    const usable = rangeUsable(f);
    if (!usable) droppedRanges.push(f);
    const start = rangeStart(f);
    const range =
      usable && start !== undefined
        ? { start_line: start, start_side: "RIGHT" as const }
        : {};
    return {
      path: f.path,
      line: f.line,
      side: "RIGHT" as const,
      ...range,
      body: renderFindingBody(usable ? f : { ...f, suggestion: undefined }),
    };
  });

  return {
    event,
    body: bodyParts.join("\n\n"),
    comments,
    droppedRanges,
  };
}

/**
 * Submits the review, pinned to the head that was gathered so comments anchor
 * to the code that was actually reviewed even if the branch moved meanwhile.
 * Aside from main.ts's failure comment, pulls.createReview is the only write
 * this tool performs.
 */
export async function submitReview(
  octokit: Octokit,
  ref: PrRef,
  plan: ReviewPlan,
  headSha: string,
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pullNumber,
    commit_id: headSha,
    event: plan.event,
    body: plan.body,
    comments: plan.comments,
  });
}
