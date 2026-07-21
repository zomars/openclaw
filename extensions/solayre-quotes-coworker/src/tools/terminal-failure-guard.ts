interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
}

interface AfterToolCallEvent extends ToolCallEvent {
  result?: unknown;
}

interface ToolHookContext {
  runId?: string;
}

interface TerminalFailureState {
  toolName: string;
  error?: string;
  code?: string;
}

interface TerminalFailureGuardOptions {
  terminalToolName: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function keyForRun(eventRunId?: string, contextRunId?: string): string | undefined {
  return eventRunId ?? contextRunId;
}

function terminalFailureFromResult(result: unknown): TerminalFailureState | undefined {
  const record = asRecord(result);
  const details = asRecord(record?.details) ?? record;
  if (!details) {
    return undefined;
  }
  if (details.success !== false || details.terminal !== true || details.nextAction !== "stop") {
    return undefined;
  }
  return {
    toolName: "",
    ...(str(details.error) ? { error: str(details.error) } : {}),
    ...(str(details.code) ? { code: str(details.code) } : {}),
  };
}

function buildBlockReason(blockedToolName: string, state: TerminalFailureState): string {
  const code = state.code ? ` code=${state.code}` : "";
  const error = state.error ? ` error=${state.error}` : "";
  return (
    `Tool "${blockedToolName}" blocked: ${state.toolName} already returned terminal=true nextAction=stop in this run${code}${error}. ` +
    "Stop this turn. Do not retry with exec, curl, vision, file conversion, save_lead, or direct endpoints."
  );
}

export function createTerminalFailureGuard(options: TerminalFailureGuardOptions) {
  const terminalFailuresByRun = new Map<string, TerminalFailureState>();

  return {
    beforeToolCall(event: ToolCallEvent, context?: ToolHookContext) {
      const runKey = keyForRun(event.runId, context?.runId);
      if (!runKey) {
        return;
      }
      const state = terminalFailuresByRun.get(runKey);
      if (!state) {
        return;
      }
      return { block: true, blockReason: buildBlockReason(event.toolName, state) };
    },

    afterToolCall(event: AfterToolCallEvent, context?: ToolHookContext) {
      if (event.toolName !== options.terminalToolName) {
        return;
      }
      const runKey = keyForRun(event.runId, context?.runId);
      if (!runKey) {
        return;
      }
      const terminalFailure = terminalFailureFromResult(event.result);
      if (!terminalFailure) {
        return;
      }
      terminalFailuresByRun.set(runKey, {
        ...terminalFailure,
        toolName: event.toolName,
      });
    },
  };
}
