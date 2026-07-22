# Contributing

Thanks for taking a look. Issues and PRs are welcome, small ones especially.

## Setup

Node 20+ and pnpm 9.

```sh
pnpm install
pnpm lint          # biome
pnpm typecheck
pnpm build         # bundles to dist/main.mjs
```

## Rules of the repo

- The action runs from the committed `dist/main.mjs`. After any `src/` change, run `pnpm build` and commit the updated dist, or CI will not match what consumers run.
- `src/model.ts` is the only file that talks to the AI SDK. Keep it that way.
- The reviewer is reviewer-only: its token gets contents read and pull-requests write, nothing more. PRs that widen its permissions will be declined.
- Reviewed projects can be any language. Nothing in prompts or defaults may assume a specific stack.
- Prompt files in `prompt/` and rule files in `rules/` are read from disk at runtime; no rebuild needed for those.

## Sending a PR

- One change per PR.
- Run `pnpm lint && pnpm typecheck` before pushing.
- Explain what the change does in the description; a sentence or two is enough.
