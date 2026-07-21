import * as core from "@actions/core";
import type { Octokit } from "./context.js";

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface IssueComment {
  author: string;
  body: string;
}

export interface LinkedIssue {
  ref: IssueRef;
  title: string;
  state: string;
  body: string;
  isPullRequest: boolean;
  comments: IssueComment[];
}

// Three ways to reference an issue: full URL, owner/repo#N, bare #N.
// They must live in one regex: matched separately, the "#42" inside
// "octo/hello#42" would also count as issue 42 of the current repo.
// Groups 1-3 = URL parts, 4-6 = owner/repo#N parts, 7 = bare #N number.
const REF_PATTERN =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)|\b([\w.-]+)\/([\w.-]+)#(\d+)|#(\d+)/g;

/** Extracts issue references from a PR description, deduped in order of first appearance. */
export function parseIssueRefs(
  body: string,
  owner: string,
  repo: string,
): IssueRef[] {
  const found = new Map<string, IssueRef>();
  for (const m of body.matchAll(REF_PATTERN)) {
    const ref: IssueRef = m[3]
      ? { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) }
      : m[6]
        ? { owner: m[4] as string, repo: m[5] as string, number: Number(m[6]) }
        : { owner, repo, number: Number(m[7] as string) };
    const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
    if (!found.has(key)) {
      found.set(key, {
        ...ref,
        owner: ref.owner.toLowerCase(),
        repo: ref.repo.toLowerCase(),
      });
    }
  }
  return [...found.values()];
}

/**
 * Fetches each referenced issue with its full comment thread. A ref that
 * cannot be fetched (no Issues permission, cross-repo token scope, 404) is
 * skipped with a warning; this never fails the review.
 */
export async function fetchLinkedIssues(
  octokit: Octokit,
  refs: IssueRef[],
): Promise<LinkedIssue[]> {
  const issues: LinkedIssue[] = [];
  for (const ref of refs) {
    try {
      const issue = await octokit.rest.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
      });
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner: ref.owner,
          repo: ref.repo,
          issue_number: ref.number,
          per_page: 100,
        },
      );
      issues.push({
        ref,
        title: issue.data.title,
        state: issue.data.state,
        body: issue.data.body ?? "",
        isPullRequest: issue.data.pull_request !== undefined,
        comments: comments.map((c) => ({
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
        })),
      });
    } catch (err) {
      core.warning(
        `Could not fetch linked issue ${ref.owner}/${ref.repo}#${ref.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return issues;
}
