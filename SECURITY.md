# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security tab, "Report a
vulnerability"). You will get a response within a few days.

## Scope notes

- The action is designed to run with a token limited to contents read and
  pull-requests write. Anything that lets it escalate past that, write code,
  or leak secrets from the workflow environment is in scope and worth
  reporting.
- Prompt injection that makes the reviewer post something harmful or exfiltrate
  repository secrets is in scope.
- The review content itself being wrong or unhelpful is a bug, not a
  vulnerability; open a normal issue for that.
