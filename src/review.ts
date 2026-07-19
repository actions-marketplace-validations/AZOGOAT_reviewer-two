import type { FileDiff, Octokit, PreviousComment, PrRef } from "./context.js";
import type { Finding, ReviewOutput, Severity } from "./schema.js";

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

/** Drops findings already raised at the same path and line in an earlier AI review. */
export function dedupeAgainstPrevious(
  findings: Finding[],
  previous: PreviousComment[],
): Finding[] {
  const seen = new Set(
    previous.filter((p) => p.line !== null).map((p) => `${p.path}:${p.line}`),
  );
  return findings.filter((f) => !seen.has(`${f.path}:${f.line}`));
}

export interface ReviewPlan {
  event: "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

function renderFindingBody(f: Finding): string {
  const suggestion = f.suggestion
    ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
    : "";
  return `${f.comment}\n\n_${f.severity} | ${f.ruleRef}_${suggestion}`;
}

function renderBodyLine(f: Finding): string {
  return `- \`${f.path}:${f.line}\` (${f.severity}, ${f.ruleRef}) ${f.comment}`;
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
  if (opts.skippedFiles.length > 0) {
    bodyParts.push(
      `Note: these files were too large to include in the review context and were only explored on demand: ${opts.skippedFiles.map((f) => `\`${f}\``).join(", ")}.`,
    );
  }

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

/** Submits the review. The only write this tool ever performs is pulls.createReview. */
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
