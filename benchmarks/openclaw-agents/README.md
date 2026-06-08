# OpenClaw Agent Model Benchmark

Tracer-bullet benchmark for comparing models as OpenClaw agents on real OpenClaw work.

Initial target models:

| Family                | Model / alias               | Notes                                      |
| --------------------- | --------------------------- | ------------------------------------------ |
| Anthropic             | `sonnet`, `opus`            | Strong baseline for architecture/debugging |
| Codex/OpenAI          | `gpt`, `gpt-5.4`, `gpt-5.5` | Strong coding baseline                     |
| DeepSeek/Ollama Cloud | `deepseek-v4-flash:cloud`   | Medium usage, cheaper/faster candidate     |
| DeepSeek/Ollama Cloud | `deepseek-v4-pro:cloud`     | Extra-high usage, frontier candidate       |

## What this benchmark measures

This is not a synthetic chatbot benchmark. It measures model behavior as an engineering teammate inside OpenClaw:

- Correctness: did it solve the task?
- Verification: did tests/build/docs checks pass?
- Time-to-solution: wall-clock duration.
- Tool discipline: did it use the right OpenClaw tools and guardrails?
- Patch quality: minimal, maintainable, no unrelated churn.
- Recovery: how well it handles ambiguous logs, failures, and retries.
- Cost/usage: provider-reported cost when available, or plan/usage notes.

## Benchmark loop

For each task/model pair:

1. Create an isolated worktree or clean checkout.
2. Run the task `setup.sh` if present.
3. Give the model the task `prompt.md` verbatim.
4. Let it work with a fixed timeout.
5. Run `verify.sh`.
6. Score with `rubric.md`.
7. Save a result JSON in `results/`.

Recommended first pass:

```text
3 tasks × 4 models × 1 run = 12 runs
```

Then repeat the most interesting or noisy cases 3×.

## Result filename convention

```text
results/YYYY-MM-DD--TASK_ID--MODEL_SLUG--run-N.json
```

Example:

```text
results/2026-05-29--001-config-schema-diagnosis--sonnet--run-1.json
```

## Safety rules

- Run tasks in isolated worktrees, not Omar's active dirty tree.
- Do not restart the gateway unless the task explicitly requires it and Omar approves.
- Do not send external messages or touch Solayre leads/clients.
- Preserve unrelated git changes.
