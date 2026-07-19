# Baseline review rules

Applied in every repository, in any language, alongside repository-specific rules. Cite the section name below as the ruleRef, for example "default: correctness".

## correctness

Off-by-one errors, wrong boundary conditions, inverted or short-circuited logic, unhandled null or empty cases, dead branches introduced by the change.

## error-handling

Errors swallowed silently, overly broad catches that hide unrelated failures, error paths that leave state half-updated, failures the caller needs to know about but never sees.

## concurrency-and-resources

Race conditions, shared mutable state without coordination, resources acquired but not released on every path (files, locks, connections, subprocesses).

## security

Injection risks, secrets in code or logs, unsafe deserialization, missing validation at trust boundaries (user input, external APIs, file contents), overly broad permissions.

## data-handling

Silent data loss, lossy or truncating conversions, timezone and encoding mistakes, unchecked external input flowing into storage or computation.

## api-contracts

Public behavior changed without need, breaking changes to callers that exist in this repository, changed defaults that silently alter results for existing users.

## tests

Changed behavior without changed tests, when the repository clearly has a test suite covering that area. Do not demand tests in areas the repository does not test.

## consistency

When the repository has an established pattern for the thing being done, an unexplained deviation is a finding. A deviation with a visible reason is not.

## Out of scope

Formatting, import order, naming taste, and anything a linter or formatter enforces. Never raise these, not even as nits.
