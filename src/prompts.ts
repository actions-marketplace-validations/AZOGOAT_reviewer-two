import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileDiff, PreviousComment, PrMeta } from "./context.js";
import type { LoadedRules } from "./rules.js";
import type { Finding } from "./schema.js";

/** Reads the bundled reviewer persona. actionRoot is the action's own directory. */
export function loadBasePrompt(actionRoot: string): string {
  return readFileSync(join(actionRoot, "prompt", "system.md"), "utf8");
}

/** Reads the bundled language-agnostic baseline rules. */
export function loadDefaultRules(actionRoot: string): string {
  return readFileSync(join(actionRoot, "rules", "default.md"), "utf8");
}

/** Assembles the system prompt: persona, baseline rules, repo context, repo rules. */
export function buildSystemPrompt(
  basePrompt: string,
  defaultRules: string,
  rules: LoadedRules,
): string {
  const parts = [basePrompt, defaultRules];
  if (rules.description) {
    parts.push(`# Repository description\n\n${rules.description}`);
  }
  for (const rule of rules.ruleFiles) {
    parts.push(`# Repository rules: ${rule.name}\n\n${rule.content}`);
  }
  return parts.join("\n\n---\n\n");
}

/** Assembles the per-PR user prompt with metadata, diff, and prior review state. */
export function buildReviewPrompt(opts: {
  meta: PrMeta;
  files: FileDiff[];
  skippedFiles: string[];
  previous: PreviousComment[];
}): string {
  const { meta, files, skippedFiles, previous } = opts;
  const parts: string[] = [
    `# Pull request\n\nTitle: ${meta.title}\nAuthor: ${meta.author}\nBase: ${meta.baseRef}\n\n${meta.body || "(no description)"}`,
  ];
  if (previous.length > 0) {
    const rendered = previous
      .map((c) => `- ${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`)
      .join("\n");
    parts.push(`# Your earlier review comments on this PR\n\n${rendered}`);
  }
  if (skippedFiles.length > 0) {
    parts.push(
      `# Files too large to include\n\nThe diff for these files was omitted for size; read them with the tools if relevant:\n${skippedFiles.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  const diff = files
    .map((f) => `## ${f.path}\n\n\`\`\`diff\n${f.patch}\`\`\``)
    .join("\n\n");
  parts.push(`# Diff\n\n${diff}`);
  parts.push(
    "This is the review pass. Explore the repository as needed, then report every issue you believe is real; a separate verification pass filters uncertain findings.",
  );
  return parts.join("\n\n");
}

/** Phase-2 prompt: re-examine one candidate finding against the actual code. */
export function buildVerifyPrompt(finding: Finding): string {
  return [
    "This is the verification pass. Re-examine this candidate finding against the actual repository code.",
    "Confirm it only if you can cite concrete code evidence that the problem is real in the current code.",
    "Discard it if it is speculative, already handled elsewhere, based on a misreading, or would be caught by a linter or formatter.",
    "",
    `File: ${finding.path}`,
    `Line: ${finding.line}`,
    `Severity: ${finding.severity}`,
    `Rule: ${finding.ruleRef}`,
    `Finding: ${finding.comment}`,
  ].join("\n");
}
