#!/usr/bin/env bash
set -euo pipefail
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts test/benchmark-fixtures/openclaw-agent-bench-normalize.test.ts
git diff --check
