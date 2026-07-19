// src/main.ts
import * as core2 from "@actions/core";
import { context, getOctokit } from "@actions/github";

// src/context.ts
import picomatch from "picomatch";
var DEFAULT_EXCLUDES = [
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
  "**/yarn.lock"
];
var excludeMatcher = picomatch(DEFAULT_EXCLUDES, {
  dot: true,
  basename: false
});
var rootExcludeMatcher = picomatch(
  DEFAULT_EXCLUDES.map((g) => g.replace(/^\*\*\//, "")),
  { dot: true }
);
function isExcluded(path2) {
  return excludeMatcher(path2) || rootExcludeMatcher(path2);
}
function parseDiff(diff) {
  const files = [];
  let current = null;
  let newLine = 0;
  let inHunk = false;
  const lines = diff.split("\n");
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
        current = {
          path: raw.replace(/^b\//, ""),
          patch: "",
          commentableLines: /* @__PURE__ */ new Set()
        };
        files.push(current);
      }
      continue;
    }
    if (!current) continue;
    current.patch += `${line}
`;
    if (line.startsWith("@@")) {
      inHunk = true;
      const m = /\+(\d+)/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      if (newLine > 0) current.commentableLines.add(newLine);
      newLine++;
    }
  }
  return files;
}
function commentableLinesFromPatch(patch) {
  const commentable = /* @__PURE__ */ new Set();
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
function filesFromListFiles(prFiles) {
  return prFiles.filter((f) => !!f.patch).map((f) => ({
    path: f.filename,
    patch: f.patch,
    commentableLines: commentableLinesFromPatch(f.patch)
  }));
}
var DEFAULT_MAX_DIFF_CHARS = 3e5;
function degradeIfOversized(files, maxChars = DEFAULT_MAX_DIFF_CHARS) {
  let total = files.reduce((n, f) => n + f.patch.length, 0);
  if (total <= maxChars) return { files, skipped: [] };
  const bySize = [...files].sort((a, b) => b.patch.length - a.patch.length);
  const skippedSet = /* @__PURE__ */ new Set();
  for (const f of bySize) {
    if (total <= maxChars) break;
    skippedSet.add(f.path);
    total -= f.patch.length;
  }
  return {
    files: files.filter((f) => !skippedSet.has(f.path)),
    skipped: [...skippedSet]
  };
}
async function gatherPr(octokit, ref) {
  const { owner, repo, pullNumber } = ref;
  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
  let allFiles;
  const omitted = [];
  try {
    const diffResponse = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: "diff" }
      }
    );
    allFiles = parseDiff(diffResponse.data);
  } catch (err) {
    if (err.status !== 406) throw err;
    allFiles = filesFromListFiles(prFiles);
    for (const f of prFiles)
      if (!f.patch && !isExcluded(f.filename)) omitted.push(f.filename);
  }
  const reviewable = allFiles.filter((f) => !isExcluded(f.path));
  const { files, skipped } = degradeIfOversized(reviewable);
  return {
    meta: {
      title: pr.data.title,
      body: pr.data.body ?? "",
      author: pr.data.user?.login ?? "unknown",
      baseRef: pr.data.base.ref,
      headSha: pr.data.head.sha
    },
    files,
    skippedFiles: [...skipped, ...omitted],
    changedPaths: prFiles.map((f) => f.filename)
  };
}
async function fetchPreviousAiComments(octokit, ref, botLogins) {
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pullNumber,
      per_page: 100
    }
  );
  const logins = new Set(botLogins);
  return comments.filter((c) => c.user && logins.has(c.user.login)).map((c) => ({ path: c.path, line: c.line ?? null, body: c.body }));
}

// src/explore.ts
import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import path from "path";
import { z } from "zod";

// src/model.ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, isStepCount, Output, tool } from "ai";
var DEFAULT_MAX_TOOL_CALLS = 50;
function resolveModel(id) {
  if (id.startsWith("claude-")) return anthropic(id);
  if (id.startsWith("gpt-") || /^o\d/.test(id)) return openai(id);
  throw new Error(
    `Unsupported model "${id}". Use a claude-* id (Anthropic) or a gpt-*/o* id (OpenAI).`
  );
}
function exceedsTokenBudget(budget) {
  return ({ steps }) => {
    if (budget === void 0) return false;
    const used = steps.reduce((n, s) => n + (s.usage.totalTokens ?? 0), 0);
    return used >= budget;
  };
}
async function runStructured(opts) {
  const result = await generateText({
    model: resolveModel(opts.modelId),
    messages: [
      {
        role: "system",
        content: opts.system,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
      },
      { role: "user", content: opts.prompt }
    ],
    tools: opts.tools,
    // step count approximates tool calls; a step may batch parallel calls
    stopWhen: [
      isStepCount(opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
      exceedsTokenBudget(opts.tokenBudget)
    ],
    output: Output.object({ schema: opts.schema })
  });
  const toolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  return { output: opts.schema.parse(result.output), toolCalls };
}

// src/explore.ts
var IGNORED_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "dist",
  "out",
  "_generated"
]);
var MAX_READ_LINES = 400;
var MAX_GREP_MATCHES = 100;
var MAX_LIST_ENTRIES = 200;
var MAX_FILE_BYTES = 1e6;
function safePath(root, p) {
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
function readFileSlice(root, file, offset = 1, limit = MAX_READ_LINES) {
  try {
    const abs = safePath(root, file);
    if (statSync(abs).size > MAX_FILE_BYTES)
      return `Error: file larger than ${MAX_FILE_BYTES} bytes`;
    const lines = readFileSync(abs, "utf8").split("\n");
    const start = Math.max(offset, 1);
    const window = lines.slice(start - 1, start - 1 + limit);
    const body = window.map((l, i) => `${start + i}	${l}`).join("\n");
    const truncated = start - 1 + limit < lines.length ? `
[truncated, file has ${lines.length} lines]` : "";
    return body + truncated;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
function looksBinary(buf) {
  return buf.subarray(0, 1024).includes(0);
}
function* walk(root, dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name))
        yield* walk(root, path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}
function grepTree(root, pattern, subdir = ".") {
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return `Error: invalid regex: ${err.message}`;
  }
  try {
    const start = safePath(root, subdir);
    const matches = [];
    for (const file of walk(root, start)) {
      let buf;
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
    return `Error: ${err.message}`;
  }
}
function listDir(root, subdir = ".") {
  try {
    const abs = safePath(root, subdir);
    const all = readdirSync(abs, { withFileTypes: true });
    const entries = all.slice(0, MAX_LIST_ENTRIES).map((e) => e.isDirectory() ? `${e.name}/` : e.name);
    if (all.length > MAX_LIST_ENTRIES)
      entries.push(`[truncated, directory has ${all.length} entries]`);
    return entries.join("\n") || "Empty directory.";
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
function makeExploreTools(repoRoot) {
  return {
    read_file: tool({
      description: "Read a file from the repository checkout. Returns numbered lines. Use offset and limit for large files.",
      inputSchema: z.object({
        path: z.string().describe("Repository-relative file path"),
        offset: z.number().int().positive().optional().describe("1-based first line, default 1"),
        limit: z.number().int().positive().optional().describe("Max lines, default 400")
      }),
      execute: async ({ path: p, offset, limit }) => readFileSlice(repoRoot, p, offset, limit)
    }),
    grep: tool({
      description: "Search file contents with a regular expression. Returns file:line: text matches.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression"),
        path: z.string().optional().describe("Directory to search, default repository root")
      }),
      execute: async ({ pattern, path: p }) => grepTree(repoRoot, pattern, p ?? ".")
    }),
    list_dir: tool({
      description: "List the entries of a directory. Directories end with a slash.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory to list, default repository root")
      }),
      execute: async ({ path: p }) => listDir(repoRoot, p ?? ".")
    })
  };
}

// src/prompts.ts
import { readFileSync as readFileSync2 } from "fs";
import { join } from "path";
function loadBasePrompt(actionRoot) {
  return readFileSync2(join(actionRoot, "prompt", "system.md"), "utf8");
}
function loadDefaultRules(actionRoot) {
  return readFileSync2(join(actionRoot, "rules", "default.md"), "utf8");
}
function buildSystemPrompt(basePrompt, defaultRules, rules) {
  const parts = [basePrompt, defaultRules];
  if (rules.description) {
    parts.push(`# Repository description

${rules.description}`);
  }
  for (const rule of rules.ruleFiles) {
    parts.push(`# Repository rules: ${rule.name}

${rule.content}`);
  }
  return parts.join("\n\n---\n\n");
}
function buildReviewPrompt(opts) {
  const { meta, files, skippedFiles, previous } = opts;
  const parts = [
    `# Pull request

Title: ${meta.title}
Author: ${meta.author}
Base: ${meta.baseRef}

${meta.body || "(no description)"}`
  ];
  if (previous.length > 0) {
    const rendered = previous.map((c) => `- ${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`).join("\n");
    parts.push(`# Your earlier review comments on this PR

${rendered}`);
  }
  if (skippedFiles.length > 0) {
    parts.push(
      `# Files too large to include

The diff for these files was omitted for size; read them with the tools if relevant:
${skippedFiles.map((f) => `- ${f}`).join("\n")}`
    );
  }
  const diff = files.map((f) => `## ${f.path}

\`\`\`diff
${f.patch}\`\`\``).join("\n\n");
  parts.push(`# Diff

${diff}`);
  parts.push(
    "This is the review pass. Explore the repository as needed, then report every issue you believe is real; a separate verification pass filters uncertain findings."
  );
  return parts.join("\n\n");
}
function buildVerifyPrompt(finding) {
  return [
    "This is the verification pass. Re-examine this candidate finding against the actual repository code.",
    "Confirm it only if you can cite concrete code evidence that the problem is real in the current code.",
    "Discard it if it is speculative, already handled elsewhere, based on a misreading, or would be caught by a linter or formatter.",
    "",
    `File: ${finding.path}`,
    `Line: ${finding.line}`,
    `Severity: ${finding.severity}`,
    `Rule: ${finding.ruleRef}`,
    `Finding: ${finding.comment}`
  ].join("\n");
}

// src/review.ts
var RANKS = {
  critical: 3,
  major: 2,
  minor: 1,
  nit: 0
};
function severityRank(s) {
  return RANKS[s];
}
function meetsThreshold(s, threshold) {
  return RANKS[s] >= RANKS[threshold];
}
function dedupeAgainstPrevious(findings, previous) {
  const seen = new Set(
    previous.filter((p) => p.line !== null).map((p) => `${p.path}:${p.line}`)
  );
  return findings.filter((f) => !seen.has(`${f.path}:${f.line}`));
}
function renderFindingBody(f) {
  const suggestion = f.suggestion ? `

\`\`\`suggestion
${f.suggestion}
\`\`\`` : "";
  return `${f.comment}

_${f.severity} | ${f.ruleRef}_${suggestion}`;
}
function renderBodyLine(f) {
  return `- \`${f.path}:${f.line}\` (${f.severity}, ${f.ruleRef}) ${f.comment}`;
}
function planReview(output, files, opts) {
  const anchorable = new Map(files.map((f) => [f.path, f.commentableLines]));
  const inlineEligible = [];
  const bodyFindings = [];
  for (const f of output.findings) {
    const anchored = anchorable.get(f.path)?.has(f.line) ?? false;
    const aboveThreshold = f.severity !== "nit" && meetsThreshold(f.severity, opts.inlineSeverityThreshold);
    if (anchored && aboveThreshold) inlineEligible.push(f);
    else bodyFindings.push(f);
  }
  const bySeverity = [...inlineEligible].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
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
        "</details>"
      ].join("\n")
    );
  }
  if (opts.skippedFiles.length > 0) {
    bodyParts.push(
      `Note: these files were too large to include in the review context and were only explored on demand: ${opts.skippedFiles.map((f) => `\`${f}\``).join(", ")}.`
    );
  }
  const event = output.findings.some(
    (f) => meetsThreshold(f.severity, opts.requestChangesThreshold)
  ) ? "REQUEST_CHANGES" : "COMMENT";
  return {
    event,
    body: bodyParts.join("\n\n"),
    comments: inline.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: renderFindingBody(f)
    }))
  };
}
async function submitReview(octokit, ref, plan) {
  await octokit.rest.pulls.createReview({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pullNumber,
    event: plan.event,
    body: plan.body,
    comments: plan.comments
  });
}

// src/rules.ts
import { existsSync, readdirSync as readdirSync2, readFileSync as readFileSync3, statSync as statSync2 } from "fs";
import { join as join2 } from "path";
import * as core from "@actions/core";
import picomatch2 from "picomatch";
import { parse as parseYaml } from "yaml";
import { z as z2 } from "zod";
var manifestSchema = z2.object({
  context: z2.string().optional(),
  always: z2.array(z2.string()).default([]),
  rules: z2.array(z2.object({ file: z2.string(), paths: z2.array(z2.string()) })).default([])
});
var FALLBACK_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md"
];
function readIfExists(path2) {
  if (!existsSync(path2)) return void 0;
  const stats = statSync2(path2);
  return stats.isFile() ? readFileSync3(path2, "utf8") : void 0;
}
function loadRules(repoRoot, changedPaths) {
  const configDir = join2(repoRoot, ".github", "ai-review");
  const manifestPath = join2(configDir, "manifest.yml");
  if (existsSync(manifestPath)) {
    try {
      return loadFromManifest(configDir, manifestPath, changedPaths);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(
        `Invalid .github/ai-review/manifest.yml, falling back to zero-config: ${msg}`
      );
      return loadFallback(repoRoot);
    }
  }
  return loadFallback(repoRoot);
}
function loadFromManifest(configDir, manifestPath, changedPaths) {
  const manifest = manifestSchema.parse(
    parseYaml(readFileSync3(manifestPath, "utf8")) ?? {}
  );
  const ruleFiles = [];
  const add = (name) => {
    const content = readIfExists(join2(configDir, name));
    if (content !== void 0) ruleFiles.push({ name, content });
  };
  for (const name of manifest.always) add(name);
  for (const rule of manifest.rules) {
    const matches = picomatch2(rule.paths, { dot: true });
    if (changedPaths.some((p) => matches(p))) add(rule.file);
  }
  const description = manifest.context ? readIfExists(join2(configDir, manifest.context)) : void 0;
  return { description, ruleFiles, source: "manifest" };
}
function loadFallback(repoRoot) {
  const ruleFiles = [];
  for (const name of FALLBACK_FILES) {
    const content = readIfExists(join2(repoRoot, name));
    if (content !== void 0) ruleFiles.push({ name, content });
  }
  const cursorRules = join2(repoRoot, ".cursor", "rules");
  if (existsSync(cursorRules)) {
    if (statSync2(cursorRules).isDirectory()) {
      for (const entry of readdirSync2(cursorRules)) {
        const content = readIfExists(join2(cursorRules, entry));
        if (content !== void 0)
          ruleFiles.push({ name: `.cursor/rules/${entry}`, content });
      }
    } else {
      ruleFiles.push({
        name: ".cursor/rules",
        content: readFileSync3(cursorRules, "utf8")
      });
    }
  }
  return { ruleFiles, source: "fallback" };
}

// src/schema.ts
import { z as z3 } from "zod";
var severities = ["critical", "major", "minor", "nit"];
var findingSchema = z3.object({
  path: z3.string().min(1).describe("Repository-relative path of the file"),
  line: z3.number().int().positive().describe("Line number in the new version of the file"),
  severity: z3.enum(severities),
  comment: z3.string().min(1).describe("Short, direct comment stating the problem and its consequence"),
  suggestion: z3.string().optional().describe(
    "Replacement code for the commented line(s), only when the fix is obvious"
  ),
  ruleRef: z3.string().min(1).describe("Rule file or section violated, or 'general'")
});
var reviewOutputSchema = z3.object({
  summary: z3.string().describe("Two to four sentence overall assessment"),
  findings: z3.array(findingSchema)
});
var verificationSchema = z3.object({
  verdict: z3.enum(["confirmed", "discarded"]),
  evidence: z3.string().describe("Concrete code evidence, or the reason for discarding")
});

// src/verify.ts
var DEFAULT_VERIFY_TOOL_CALLS = 10;
async function verifyFindings(opts) {
  const confirmed = [];
  for (const finding of opts.findings) {
    try {
      const { output } = await runStructured({
        modelId: opts.modelId,
        system: opts.system,
        prompt: buildVerifyPrompt(finding),
        schema: verificationSchema,
        tools: opts.tools,
        maxToolCalls: opts.maxToolCallsPerFinding ?? DEFAULT_VERIFY_TOOL_CALLS
      });
      if (output.verdict === "confirmed") confirmed.push(finding);
    } catch {
      confirmed.push(finding);
    }
  }
  return confirmed;
}

// src/main.ts
function severityInput(name, fallback) {
  const raw = core2.getInput(name) || fallback;
  if (!severities.includes(raw)) {
    throw new Error(
      `Input ${name} must be one of ${severities.join(", ")}, got "${raw}"`
    );
  }
  return raw;
}
function numberInput(name, fallback) {
  const raw = core2.getInput(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Input ${name} must be a finite positive number, got "${raw}"`
    );
  }
  return value;
}
function readInputs() {
  return {
    model: core2.getInput("model") || "claude-opus-4-8",
    maxToolCalls: numberInput("max_tool_calls", 50),
    explorationTokenBudget: numberInput("exploration_token_budget", void 0),
    maxInlineComments: numberInput("max_inline_comments", 15),
    inlineSeverityThreshold: severityInput(
      "inline_severity_threshold",
      "minor"
    ),
    requestChangesThreshold: severityInput(
      "request_changes_threshold",
      "major"
    ),
    reviewerLogin: core2.getInput("reviewer_login") || "light-ai-reviewer",
    dryRun: core2.getInput("dry_run") === "true"
  };
}
function shouldSkip(payload, inputs, eventName) {
  if (payload.pull_request?.draft && eventName !== "workflow_dispatch") {
    return "PR is a draft; request a review again when it is ready";
  }
  if (payload.action === "review_requested" && payload.requested_reviewer?.login !== void 0) {
    const login = payload.requested_reviewer.login;
    if (login !== inputs.reviewerLogin) {
      return `review requested from ${login}, not from ${inputs.reviewerLogin}`;
    }
  }
  return null;
}
function exportApiKeys() {
  const anthropicKey = core2.getInput("anthropic_api_key");
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  const openaiKey = core2.getInput("openai_api_key");
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
}
async function postFailureComment(octokit, ref) {
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${ref.owner}/${ref.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    body: `The AI review failed before producing a result. See the run log: ${runUrl}`
  });
}
async function run() {
  const inputs = readInputs();
  exportApiKeys();
  const skipReason = shouldSkip(
    context.payload,
    inputs,
    context.eventName
  );
  if (skipReason) {
    core2.info(`Skipping review: ${skipReason}`);
    return;
  }
  const pullNumber = context.payload.pull_request?.number ?? Number(core2.getInput("pull_number"));
  if (!pullNumber) {
    core2.setFailed(
      "No pull request number available from the event or the pull_number input."
    );
    return;
  }
  const token = core2.getInput("github_token", { required: true });
  const octokit = getOctokit(token);
  const ref = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber
  };
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const actionRoot = process.env.GITHUB_ACTION_PATH ?? workspace;
  try {
    const pr = await gatherPr(octokit, ref);
    const rules = loadRules(workspace, pr.changedPaths);
    const previous = await fetchPreviousAiComments(octokit, ref, [
      inputs.reviewerLogin,
      "github-actions[bot]"
    ]);
    const system = buildSystemPrompt(
      loadBasePrompt(actionRoot),
      loadDefaultRules(actionRoot),
      rules
    );
    const tools = makeExploreTools(workspace);
    core2.info(
      `Phase 1: reviewing with ${inputs.model} (rules source: ${rules.source})`
    );
    const phase1 = await runStructured({
      modelId: inputs.model,
      system,
      prompt: buildReviewPrompt({
        meta: pr.meta,
        files: pr.files,
        skippedFiles: pr.skippedFiles,
        previous
      }),
      schema: reviewOutputSchema,
      tools,
      maxToolCalls: inputs.maxToolCalls,
      tokenBudget: inputs.explorationTokenBudget
    });
    core2.info(
      `Phase 1 done: ${phase1.output.findings.length} candidate findings, ${phase1.toolCalls} tool calls`
    );
    const fresh = dedupeAgainstPrevious(phase1.output.findings, previous);
    core2.info(`Phase 2: verifying ${fresh.length} findings`);
    const confirmed = await verifyFindings({
      modelId: inputs.model,
      system,
      findings: fresh,
      tools
    });
    core2.info(`Phase 2 done: ${confirmed.length} confirmed`);
    const plan = planReview(
      { summary: phase1.output.summary, findings: confirmed },
      pr.files,
      {
        maxInlineComments: inputs.maxInlineComments,
        inlineSeverityThreshold: inputs.inlineSeverityThreshold,
        requestChangesThreshold: inputs.requestChangesThreshold,
        skippedFiles: pr.skippedFiles
      }
    );
    if (inputs.dryRun) {
      core2.info(
        `Dry run, review not posted:
${JSON.stringify(plan, null, 2)}`
      );
      return;
    }
    await submitReview(octokit, ref, plan);
    core2.info(
      `Review submitted: ${plan.event}, ${plan.comments.length} inline comments`
    );
  } catch (err) {
    if (inputs.dryRun) {
      core2.error(
        `Dry run: AI review failed, not posting a PR comment. ${err instanceof Error ? err.message : String(err)}`
      );
    } else {
      await postFailureComment(octokit, ref).catch(
        (e) => core2.warning(`Could not post failure comment: ${e}`)
      );
    }
    core2.setFailed(err instanceof Error ? err.message : String(err));
  }
}
async function main() {
  try {
    await run();
  } catch (err) {
    core2.setFailed(err instanceof Error ? err.message : String(err));
  }
}
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === void 0) {
  await main();
}
export {
  main,
  readInputs,
  run,
  shouldSkip
};
