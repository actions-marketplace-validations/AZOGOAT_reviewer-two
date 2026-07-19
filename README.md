# ai-reviewer

AI code review for pull requests. You ask for a review the same way you'd ask a teammate, and what comes back is an ordinary GitHub review: inline comments, one-click suggestions where they help, and a COMMENT or REQUEST_CHANGES verdict. Under the hood it reads through the repo first, then re-checks every finding before posting, so it leans toward fewer, better comments. It never approves, and it cannot touch your code: the token only has contents read and pull-requests write.

Works with any language. Rules and conventions come from your repository, not from the tool.

## Quick start (solo, any repo)

Add `.github/workflows/ai-review.yml`:

```yaml
name: AI review
on:
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      pull_number:
        required: true
concurrency:
  group: ai-review-${{ inputs.pull_number || github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || github.event.label.name == 'ai-review'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Validate PR number
        if: github.event_name == 'workflow_dispatch'
        env:
          PULL_NUMBER: ${{ inputs.pull_number }}
        run: |
          [[ "$PULL_NUMBER" =~ ^[0-9]+$ ]] || { echo "pull_number must be numeric"; exit 1; }
      - uses: actions/checkout@v4
        with:
          # Works for both label and manual dispatch runs
          ref: refs/pull/${{ inputs.pull_number || github.event.pull_request.number }}/head
      - uses: azogoat/ai-reviewer@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pull_number: ${{ inputs.pull_number || github.event.pull_request.number }}
```

Set the `ANTHROPIC_API_KEY` secret, then add the `ai-review` label to any PR. The review posts as github-actions.

## Team mode (machine user)

1. Create a dedicated GitHub account (for example `light-ai-reviewer`) and add it to the org or repo as a collaborator.
2. Create a fine-grained PAT for it with Contents: read and Pull requests: read and write. Store it as the `AI_REVIEWER_TOKEN` secret.
3. Add `.github/workflows/ai-review.yml`:

```yaml
name: AI review
on:
  pull_request:
    types: [review_requested]
jobs:
  review:
    uses: azogoat/ai-reviewer/.github/workflows/review.yml@v1
    secrets:
      ai_reviewer_token: ${{ secrets.AI_REVIEWER_TOKEN }}
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Now requesting a review from the machine user triggers a review under its identity. Re-requesting triggers a fresh incremental review that only raises new or unresolved issues.

## Configuration (optional)

Zero config works: the reviewer auto-detects README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, and .cursor/rules as context.

For full control add `.github/ai-review/manifest.yml`:

```yaml
context: description.md
always: [rules.md]
rules:
  - file: rules-python.md
    paths: ["**/*.py"]
```

Only rule files matching the PR's changed paths are loaded.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| model | claude-opus-4-8 | Any claude-* or gpt-*/o* model id |
| max_tool_calls | 50 | Exploration cap (runaway guard, raise freely for large repos) |
| exploration_token_budget | unset | Optional total token cap across exploration |
| max_inline_comments | 15 | Rest of the findings collapse into the review body |
| inline_severity_threshold | minor | Minimum severity posted inline; nits never post inline |
| request_changes_threshold | major | Minimum severity for a REQUEST_CHANGES verdict |
| reviewer_login | light-ai-reviewer | Machine user guard in team mode |
| dry_run | false | Log the review instead of posting |

Note: the remaining inputs (github_token, anthropic_api_key, openai_api_key, pull_number) appear in the examples above and are documented in action.yml.

## Cost and model notes

Default is the strongest Claude model because review quality is the product; a deep review of a mid-size PR lands around 1 to 3 USD. Any repo can set a cheaper model. Switching to a GPT model is just the model input plus an `openai_api_key` secret; there are no separate code paths.
