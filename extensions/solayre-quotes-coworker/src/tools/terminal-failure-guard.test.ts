import { describe, expect, it } from "vitest";
import { createTerminalFailureGuard } from "./terminal-failure-guard.js";

const terminalToolName = "solayre_quotes_coworker__process_cfe_receipt";

describe("createTerminalFailureGuard", () => {
  it("blocks subsequent tools in the same run after a terminal receipt failure", () => {
    const guard = createTerminalFailureGuard({ terminalToolName });

    expect(
      guard.beforeToolCall({
        toolName: "exec",
        params: {},
        runId: "run-1",
      }),
    ).toBeUndefined();

    guard.afterToolCall({
      toolName: terminalToolName,
      params: {},
      runId: "run-1",
      result: {
        details: {
          success: false,
          error: "INVALID_CONTENT_TYPE",
          code: "INVALID_CONTENT_TYPE",
          terminal: true,
          nextAction: "stop",
        },
      },
    });

    expect(
      guard.beforeToolCall({
        toolName: "exec",
        params: {},
        runId: "run-1",
      }),
    ).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("terminal=true nextAction=stop"),
    });
    expect(
      guard.beforeToolCall({
        toolName: "save_lead",
        params: {},
        runId: "run-1",
      }),
    ).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("save_lead"),
    });
  });

  it("does not block a different run after a terminal receipt failure", () => {
    const guard = createTerminalFailureGuard({ terminalToolName });

    guard.afterToolCall({
      toolName: terminalToolName,
      params: {},
      runId: "run-1",
      result: {
        details: {
          success: false,
          error: "INVALID_CONTENT_TYPE",
          terminal: true,
          nextAction: "stop",
        },
      },
    });

    expect(
      guard.beforeToolCall({
        toolName: terminalToolName,
        params: { mediaPath: "/tmp/new-receipt.pdf" },
        runId: "run-2",
      }),
    ).toBeUndefined();
  });

  it("ignores non-terminal failures", () => {
    const guard = createTerminalFailureGuard({ terminalToolName });

    guard.afterToolCall({
      toolName: terminalToolName,
      params: {},
      runId: "run-1",
      result: {
        details: {
          success: false,
          error: "retryable",
        },
      },
    });

    expect(
      guard.beforeToolCall({
        toolName: "exec",
        params: {},
        runId: "run-1",
      }),
    ).toBeUndefined();
  });
});
