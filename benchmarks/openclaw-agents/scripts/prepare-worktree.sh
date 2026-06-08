#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <task-id> <model-slug> [base-ref]" >&2
  exit 2
fi

TASK_ID="$1"
MODEL_SLUG="$2"
BASE_REF="${3:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORKTREE="$ROOT/.artifacts/openclaw-agent-bench/$TASK_ID/$MODEL_SLUG/$STAMP"
TASK_DIR="$ROOT/benchmarks/openclaw-agents/tasks/$TASK_ID"

if [[ ! -d "$TASK_DIR" ]]; then
  echo "Task not found: $TASK_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$WORKTREE")"
git worktree add --detach "$WORKTREE" "$BASE_REF"

if [[ -x "$TASK_DIR/setup.sh" ]]; then
  (cd "$WORKTREE" && "$TASK_DIR/setup.sh")
fi

cat <<MSG
Prepared benchmark worktree.

Task:      $TASK_ID
Model:     $MODEL_SLUG
Base ref:  $BASE_REF
Worktree:  $WORKTREE
Prompt:    $TASK_DIR/prompt.md
Verify:    $TASK_DIR/verify.sh

Next:
1. Run the model against the prompt in the worktree above.
2. Save transcript/diff/logs under .artifacts/openclaw-agent-bench/.
3. Run: (cd "$WORKTREE" && "$TASK_DIR/verify.sh")
MSG
