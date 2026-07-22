import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import {
  fetchPreviousAiComments,
  gatherPr,
  type Octokit,
  type PrRef,
} from "./context.js";
import { makeExploreTools } from "./explore.js";
import { fetchLinkedIssues, parseIssueRefs } from "./issues.js";
import { runStructured } from "./model.js";
import {
  buildReviewPrompt,
  buildSystemPrompt,
  loadBasePrompt,
  loadDefaultRules,
} from "./prompts.js";
import { dedupeAgainstPrevious, planReview, submitReview } from "./review.js";
import { loadRules } from "./rules.js";
import { reviewOutputSchema, type Severity, severities } from "./schema.js";
import { verifyFindings } from "./verify.js";
import { fetchReferencedWorkflows, parseWorkflowRefs } from "./workflows.js";

export interface Inputs {
  model: string;
  maxToolCalls: number;
  explorationTokenBudget?: number;
  maxInlineComments: number;
  inlineSeverityThreshold: Severity;
  requestChangesThreshold: Severity;
  reviewerLogin: string;
  dryRun: boolean;
}

function severityInput(name: string, fallback: Severity): Severity {
  const raw = core.getInput(name) || fallback;
  if (!(severities as readonly string[]).includes(raw)) {
    throw new Error(
      `Input ${name} must be one of ${severities.join(", ")}, got "${raw}"`,
    );
  }
  return raw as Severity;
}

/**
 * Parses a numeric input. Empty input returns the fallback (undefined for
 * budgets with none). A non-empty value that is not a finite positive
 * number throws, naming the input and the bad value, so it never flows
 * downstream as NaN.
 */
function numberInput(name: string, fallback: number): number;
function numberInput(name: string, fallback: undefined): number | undefined;
function numberInput(
  name: string,
  fallback: number | undefined,
): number | undefined {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Input ${name} must be a finite positive number, got "${raw}"`,
    );
  }
  return value;
}

/** Reads and validates all action inputs. */
export function readInputs(): Inputs {
  return {
    model: core.getInput("model") || "claude-opus-4-8",
    maxToolCalls: numberInput("max_tool_calls", 50),
    explorationTokenBudget: numberInput("exploration_token_budget", undefined),
    maxInlineComments: numberInput("max_inline_comments", 15),
    inlineSeverityThreshold: severityInput(
      "inline_severity_threshold",
      "minor",
    ),
    requestChangesThreshold: severityInput(
      "request_changes_threshold",
      "major",
    ),
    reviewerLogin: core.getInput("reviewer_login") || "light-ai-reviewer",
    dryRun: core.getInput("dry_run") === "true",
  };
}

interface WebhookPayload {
  pull_request?: { draft?: boolean };
  action?: string;
  requested_reviewer?: { login?: string };
}

/** Returns a skip reason, or null when the review should run. */
export function shouldSkip(
  payload: WebhookPayload,
  inputs: Inputs,
  eventName: string,
): string | null {
  if (payload.pull_request?.draft && eventName !== "workflow_dispatch") {
    return "PR is a draft; request a review again when it is ready";
  }
  if (
    payload.action === "review_requested" &&
    payload.requested_reviewer?.login !== undefined
  ) {
    const login = payload.requested_reviewer.login;
    if (login !== inputs.reviewerLogin) {
      return `review requested from ${login}, not from ${inputs.reviewerLogin}`;
    }
  }
  return null;
}

function exportApiKeys(): void {
  const anthropicKey = core.getInput("anthropic_api_key");
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  const openaiKey = core.getInput("openai_api_key");
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
}

async function postFailureComment(octokit: Octokit, ref: PrRef): Promise<void> {
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${ref.owner}/${ref.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    body: `The AI review failed before producing a result. See the run log: ${runUrl}`,
  });
}

/** Full pipeline: guard, gather, phase 1, dedupe, phase 2, compose, submit. */
export async function run(): Promise<void> {
  const inputs = readInputs();
  exportApiKeys();

  const skipReason = shouldSkip(
    context.payload as WebhookPayload,
    inputs,
    context.eventName,
  );
  if (skipReason) {
    core.info(`Skipping review: ${skipReason}`);
    return;
  }

  const pullNumber =
    (context.payload as { pull_request?: { number?: number } }).pull_request
      ?.number ?? Number(core.getInput("pull_number"));
  if (!pullNumber) {
    core.setFailed(
      "No pull request number available from the event or the pull_number input.",
    );
    return;
  }

  const token = core.getInput("github_token", { required: true });
  const octokit = getOctokit(token);
  const ref: PrRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber,
  };
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const actionRoot =
    process.env.GITHUB_ACTION_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const pr = await gatherPr(octokit, ref);
    const rules = loadRules(workspace, pr.changedPaths);
    const previous = await fetchPreviousAiComments(octokit, ref, [
      inputs.reviewerLogin,
      "github-actions[bot]",
    ]);
    const linkedIssues = await fetchLinkedIssues(
      octokit,
      parseIssueRefs(pr.meta.body, ref.owner, ref.repo),
    );
    if (linkedIssues.length > 0)
      core.info(`Linked issues: ${linkedIssues.length} fetched for context`);
    const referencedWorkflows = await fetchReferencedWorkflows(
      octokit,
      parseWorkflowRefs(pr.files),
    );
    if (referencedWorkflows.length > 0)
      core.info(
        `Referenced workflows: ${referencedWorkflows.length} fetched for context`,
      );

    const system = buildSystemPrompt(
      loadBasePrompt(actionRoot),
      loadDefaultRules(actionRoot),
      rules,
    );
    const tools = makeExploreTools(workspace);

    core.info(
      `Phase 1: reviewing with ${inputs.model} (rules source: ${rules.source})`,
    );
    const phase1 = await runStructured({
      modelId: inputs.model,
      system,
      prompt: buildReviewPrompt({
        meta: pr.meta,
        files: pr.files,
        skippedFiles: pr.skippedFiles,
        previous,
        linkedIssues,
        referencedWorkflows,
      }),
      schema: reviewOutputSchema,
      tools,
      maxToolCalls: inputs.maxToolCalls,
      tokenBudget: inputs.explorationTokenBudget,
    });
    core.info(
      `Phase 1 done: ${phase1.output.findings.length} candidate findings, ${phase1.toolCalls} tool calls`,
    );

    const fresh = dedupeAgainstPrevious(phase1.output.findings, previous);
    core.info(`Phase 2: verifying ${fresh.length} findings`);
    const confirmed = await verifyFindings({
      modelId: inputs.model,
      system,
      findings: fresh,
      tools,
    });
    core.info(`Phase 2 done: ${confirmed.length} confirmed`);

    const plan = planReview(
      { summary: phase1.output.summary, findings: confirmed },
      pr.files,
      {
        maxInlineComments: inputs.maxInlineComments,
        inlineSeverityThreshold: inputs.inlineSeverityThreshold,
        requestChangesThreshold: inputs.requestChangesThreshold,
        skippedFiles: pr.skippedFiles,
      },
    );

    if (inputs.dryRun) {
      core.info(
        `Dry run, review not posted:\n${JSON.stringify(plan, null, 2)}`,
      );
      return;
    }
    await submitReview(octokit, ref, plan);
    core.info(
      `Review submitted: ${plan.event}, ${plan.comments.length} inline comments`,
    );
  } catch (err) {
    if (inputs.dryRun) {
      core.error(
        `Dry run: AI review failed, not posting a PR comment. ${err instanceof Error ? err.message : String(err)}`,
      );
    } else {
      await postFailureComment(octokit, ref).catch((e) =>
        core.warning(`Could not post failure comment: ${e}`),
      );
    }
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Entry wrapper: catches errors thrown before run()'s own try block (input
 * validation, missing github_token) so the job fails cleanly via setFailed
 * instead of an unhandled rejection. No PR comment here; that guarantee is
 * scoped to model/API failures inside run(), where a token is known to exist.
 */
export async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

// Entry point when executed as the action bundle; guarded so tests can import safely.
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === undefined) {
  await main();
}
