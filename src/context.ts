import type { getOctokit } from "@actions/github";
import picomatch from "picomatch";

export type Octokit = ReturnType<typeof getOctokit>;

export interface FileDiff {
  path: string;
  patch: string;
  commentableLines: Set<number>;
}

export interface PrMeta {
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headSha: string;
}

export interface PrContext {
  meta: PrMeta;
  files: FileDiff[];
  skippedFiles: string[];
  changedPaths: string[];
}

export interface PreviousComment {
  path: string;
  line: number | null;
  body: string;
}

export interface PrRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/*.egg-info/**",
  "**/_generated/**",
  "**/dist/**",
  "**/out/**",
  "**/poetry.lock",
  "**/uv.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

// "**/" matches zero directories, so root-level lockfiles match too
const excludeMatcher = picomatch(DEFAULT_EXCLUDES, {
  dot: true,
  basename: false,
});

/** True for lockfiles and generated paths that must never enter review content. */
export function isExcluded(path: string): boolean {
  return excludeMatcher(path);
}

/**
 * Parses a unified diff into per-file patches. commentableLines holds the
 * new-side line numbers present in hunks; GitHub inline comments only anchor there.
 */
export function parseDiff(diff: string): FileDiff[] {
  const files: { path: string; patch: string }[] = [];
  let current: { path: string; patch: string } | null = null;
  // a "+++ " header is only expected before the first "@@" of a file; once
  // inside a hunk body, a line that happens to start with "+++ " is content
  // (e.g. an added line of "++ x"), not a phantom next file.
  let inHunk = false;
  const lines = diff.split("\n");
  // a trailing newline yields one empty tail element; it is not a diff line
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ") && !inHunk) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") {
        current = null;
      } else {
        current = { path: raw.replace(/^b\//, ""), patch: "" };
        files.push(current);
      }
      continue;
    }
    if (!current) continue;
    current.patch += `${line}\n`;
    if (line.startsWith("@@")) inHunk = true;
  }
  return files.map((f) => ({
    ...f,
    // drop the trailing newline; an empty tail would count as a context line
    commentableLines: commentableLinesFromPatch(f.patch.replace(/\n$/, "")),
  }));
}

/** New-side commentable lines for one file's standalone hunk patch (no file headers). */
function commentableLinesFromPatch(patch: string): Set<number> {
  const commentable = new Set<number>();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      if (newLine > 0) commentable.add(newLine);
      newLine++;
    }
  }
  return commentable;
}

/**
 * Builds FileDiff entries from the listFiles response instead of the whole
 * diff. Used when the whole-diff request is rejected for size (HTTP 406).
 * Files without a patch (binary, too large for GitHub to include) are
 * skipped here; the caller reports them in skippedFiles.
 */
function filesFromListFiles(
  prFiles: { filename: string; patch?: string }[],
): FileDiff[] {
  return prFiles
    .filter((f): f is { filename: string; patch: string } => !!f.patch)
    .map((f) => ({
      path: f.filename,
      patch: f.patch,
      commentableLines: commentableLinesFromPatch(f.patch),
    }));
}

const DEFAULT_MAX_DIFF_CHARS = 300_000;

/**
 * Keeps the total patch size under maxChars by dropping the largest file
 * patches first. Dropped paths are reported, never silently lost.
 */
export function degradeIfOversized(
  files: FileDiff[],
  maxChars = DEFAULT_MAX_DIFF_CHARS,
): { files: FileDiff[]; skipped: string[] } {
  let total = files.reduce((n, f) => n + f.patch.length, 0);
  if (total <= maxChars) return { files, skipped: [] };
  const bySize = [...files].sort((a, b) => b.patch.length - a.patch.length);
  const skippedSet = new Set<string>();
  for (const f of bySize) {
    if (total <= maxChars) break;
    skippedSet.add(f.path);
    total -= f.patch.length;
  }
  return {
    files: files.filter((f) => !skippedSet.has(f.path)),
    skipped: [...skippedSet],
  };
}

/** Fetches PR metadata and diff, applying excludes and the oversize guard. */
export async function gatherPr(
  octokit: Octokit,
  ref: PrRef,
): Promise<PrContext> {
  const { owner, repo, pullNumber } = ref;
  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  let allFiles: FileDiff[];
  try {
    const diffResponse = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: "diff" },
      },
    );
    allFiles = parseDiff(diffResponse.data as unknown as string);
  } catch (err) {
    if ((err as { status?: number }).status !== 406) throw err;
    // PR too large for GitHub to render as one diff; per-file patches still work.
    allFiles = filesFromListFiles(prFiles);
  }
  // patchless files (binary, too large) are reported
  const present = new Set(allFiles.map((f) => f.path));
  const omitted = prFiles
    .filter(
      (f) => !f.patch && !present.has(f.filename) && !isExcluded(f.filename),
    )
    .map((f) => f.filename);
  const reviewable = allFiles.filter((f) => !isExcluded(f.path));
  const { files, skipped } = degradeIfOversized(reviewable);
  return {
    meta: {
      title: pr.data.title,
      body: pr.data.body ?? "",
      author: pr.data.user?.login ?? "unknown",
      baseRef: pr.data.base.ref,
      headSha: pr.data.head.sha,
    },
    files,
    skippedFiles: [...skipped, ...omitted],
    changedPaths: prFiles.map((f) => f.filename),
  };
}

/** Fetches earlier inline review comments posted by the reviewer identities. */
export async function fetchPreviousAiComments(
  octokit: Octokit,
  ref: PrRef,
  botLogins: string[],
): Promise<PreviousComment[]> {
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pullNumber,
      per_page: 100,
    },
  );
  const logins = new Set(botLogins);
  return comments
    .filter((c) => c.user && logins.has(c.user.login))
    .map((c) => ({ path: c.path, line: c.line ?? null, body: c.body }));
}
