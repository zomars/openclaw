# Task 001 — Config schema diagnosis

You are working in the OpenClaw repository.

Scenario: a user wants to change an OpenClaw gateway/session config field, but the exact field path and type may have changed. Diagnose the safe workflow and identify the relevant source/docs locations that define the config schema and config editing guardrails.

Deliverables:

1. A short diagnosis of the safe config-change workflow.
2. The exact files/docs you inspected.
3. A recommended command/tool sequence for a future config change.
4. No code changes unless you find a clear docs typo.

Constraints:

- Do not edit `~/.openclaw/openclaw.json` directly.
- Do not restart the gateway.
- Prefer schema lookup over guessing config paths.
- Preserve unrelated git changes.
