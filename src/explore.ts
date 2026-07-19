import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./model.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "dist",
  "out",
  "_generated",
]);
const MAX_READ_LINES = 400;
const MAX_GREP_MATCHES = 100;
const MAX_LIST_ENTRIES = 200;
const MAX_FILE_BYTES = 1_000_000;

/** Resolves a repo-relative path, refusing anything outside the root. */
export function safePath(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const normalRoot = path.resolve(root);
  if (abs !== normalRoot && !abs.startsWith(normalRoot + path.sep)) {
    throw new Error(`path outside the repository root: ${p}`);
  }

  const realRoot = realpathSync(normalRoot);
  let realTarget = realRoot;
  try {
    realTarget = realpathSync(abs);
  } catch {
    let current = abs;
    while (current !== normalRoot) {
      try {
        realTarget = realpathSync(current);
        break;
      } catch {
        current = path.dirname(current);
      }
    }
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`path outside the repository root: ${p}`);
  }

  return abs;
}

/** Reads a numbered window of a file. */
export function readFileSlice(
  root: string,
  file: string,
  offset = 1,
  limit = MAX_READ_LINES,
): string {
  try {
    const abs = safePath(root, file);
    if (statSync(abs).size > MAX_FILE_BYTES)
      return `Error: file larger than ${MAX_FILE_BYTES} bytes`;
    const lines = readFileSync(abs, "utf8").split("\n");
    const start = Math.max(offset, 1);
    const window = lines.slice(start - 1, start - 1 + limit);
    const body = window.map((l, i) => `${start + i}\t${l}`).join("\n");
    const truncated =
      start - 1 + limit < lines.length
        ? `\n[truncated, file has ${lines.length} lines]`
        : "";
    return body + truncated;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 1024).includes(0);
}

function* walk(root: string, dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name))
        yield* walk(root, path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Regex line search across the tree, capped and skipping vendored dirs. */
export function grepTree(root: string, pattern: string, subdir = "."): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return `Error: invalid regex: ${(err as Error).message}`;
  }
  try {
    const start = safePath(root, subdir);
    const matches: string[] = [];
    for (const file of walk(root, start)) {
      let buf: Buffer;
      try {
        buf = readFileSync(file);
      } catch {
        continue;
      }
      if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue;
      const rel = path.relative(root, file);
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? "")) {
          matches.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim()}`);
          if (matches.length >= MAX_GREP_MATCHES) {
            matches.push(`[stopped at ${MAX_GREP_MATCHES} matches]`);
            return matches.join("\n");
          }
        }
      }
    }
    return matches.length > 0 ? matches.join("\n") : "No matches.";
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/** Lists one directory, directories suffixed with a slash. */
export function listDir(root: string, subdir = "."): string {
  try {
    const abs = safePath(root, subdir);
    const all = readdirSync(abs, { withFileTypes: true });
    const entries = all
      .slice(0, MAX_LIST_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (all.length > MAX_LIST_ENTRIES)
      entries.push(`[truncated, directory has ${all.length} entries]`);
    return entries.join("\n") || "Empty directory.";
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/** The three read-only tools the review agent gets over the checkout. */
export function makeExploreTools(repoRoot: string) {
  return {
    read_file: defineTool({
      description:
        "Read a file from the repository checkout. Returns numbered lines. Use offset and limit for large files.",
      inputSchema: z.object({
        path: z.string().describe("Repository-relative file path"),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based first line, default 1"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max lines, default 400"),
      }),
      execute: async ({ path: p, offset, limit }) =>
        readFileSlice(repoRoot, p, offset, limit),
    }),
    grep: defineTool({
      description:
        "Search file contents with a regular expression. Returns file:line: text matches.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression"),
        path: z
          .string()
          .optional()
          .describe("Directory to search, default repository root"),
      }),
      execute: async ({ pattern, path: p }) =>
        grepTree(repoRoot, pattern, p ?? "."),
    }),
    list_dir: defineTool({
      description:
        "List the entries of a directory. Directories end with a slash.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Directory to list, default repository root"),
      }),
      execute: async ({ path: p }) => listDir(repoRoot, p ?? "."),
    }),
  };
}
