import * as core from "@actions/core";
import type { Octokit } from "./context.js";

export interface WorkflowRef {
  owner: string;
  repo: string;
  path: string;
  gitRef: string;
}

export interface ReferencedWorkflow {
  ref: WorkflowRef;
  content: string;
}

// Matches reusable workflow calls only; plain action refs (owner/repo@ref) have no workflow path.
const USES_PATTERN =
  /\buses:\s*([\w.-]+)\/([\w.-]+)\/(\.github\/workflows\/[\w.-]+\.ya?ml)@([\w./-]+)/g;

/** Extracts reusable workflow references from changed workflow files, deduped. */
export function parseWorkflowRefs(
  files: { path: string; patch: string }[],
): WorkflowRef[] {
  const found = new Map<string, WorkflowRef>();
  for (const file of files) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path)) continue;
    for (const m of file.patch.matchAll(USES_PATTERN)) {
      const ref: WorkflowRef = {
        owner: m[1] as string,
        repo: m[2] as string,
        path: m[3] as string,
        gitRef: m[4] as string,
      };
      const key =
        `${ref.owner}/${ref.repo}/${ref.path}@${ref.gitRef}`.toLowerCase();
      if (!found.has(key)) found.set(key, ref);
    }
  }
  return [...found.values()];
}

/**
 * Fetches each referenced workflow file so the review can judge a caller
 * against what the callee actually does. A ref that cannot be fetched
 * (private repo, moved ref, 404) is skipped with a warning; this never
 * fails the review.
 */
export async function fetchReferencedWorkflows(
  octokit: Octokit,
  refs: WorkflowRef[],
): Promise<ReferencedWorkflow[]> {
  const workflows: ReferencedWorkflow[] = [];
  for (const ref of refs) {
    try {
      const res = await octokit.rest.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: ref.path,
        ref: ref.gitRef,
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
        throw new Error("response is not a file");
      }
      workflows.push({
        ref,
        content: Buffer.from(data.content, "base64").toString("utf8"),
      });
    } catch (err) {
      core.warning(
        `Could not fetch reusable workflow ${ref.owner}/${ref.repo}/${ref.path}@${ref.gitRef}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return workflows;
}
