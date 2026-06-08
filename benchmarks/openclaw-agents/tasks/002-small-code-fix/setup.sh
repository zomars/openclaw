#!/usr/bin/env bash
set -euo pipefail
mkdir -p test/benchmark-fixtures
cat > test/benchmark-fixtures/openclaw-agent-bench-normalize.test.ts <<'TEST'
import { describe, expect, it } from 'vitest';

function normalizeProviderModel(input: string): string {
  return input.trim();
}

describe('benchmark fixture: provider/model normalization', () => {
  it('normalizes accidental repeated slashes in provider model ids', () => {
    expect(normalizeProviderModel(' ollama//deepseek-v4-pro:cloud ')).toBe('ollama/deepseek-v4-pro:cloud');
  });
});
TEST
