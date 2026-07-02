// Message received admission tests cover plugin suppression and internal observability.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearInternalHooks, registerInternalHook } from "./internal-hooks.js";
import type { CanonicalInboundMessageHookContext } from "./message-hook-mappers.js";
import { runMessageReceivedAdmissionHooks } from "./message-received-admission.js";

const hookRunnerMocks = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
  runner: {
    hasHooks: vi.fn<(hookName: string) => boolean>(() => false),
    runMessageReceived: vi.fn(async () => undefined),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunnerMocks.getGlobalHookRunner,
}));

function makeCanonical(
  overrides: Partial<CanonicalInboundMessageHookContext> = {},
): CanonicalInboundMessageHookContext {
  return {
    from: "telegram:user-1",
    to: "telegram:bot",
    content: "hello",
    channelId: "telegram",
    accountId: "default",
    conversationId: "telegram:user-1",
    sessionKey: "agent:main:telegram:user-1",
    messageId: "msg-1",
    isGroup: false,
    ...overrides,
  };
}

function admissionParams(
  overrides: Partial<Parameters<typeof runMessageReceivedAdmissionHooks>[0]> = {},
): Parameters<typeof runMessageReceivedAdmissionHooks>[0] {
  return {
    canonical: makeCanonical(),
    sessionKey: "agent:main:telegram:user-1",
    pluginFailureLogLabel: "test: plugin hook failed",
    internalFailureLogLabel: "test: internal hook failed",
    ...overrides,
  };
}

describe("runMessageReceivedAdmissionHooks", () => {
  beforeEach(() => {
    clearInternalHooks();
    hookRunnerMocks.getGlobalHookRunner.mockReset();
    hookRunnerMocks.runner.hasHooks.mockReset().mockReturnValue(false);
    hookRunnerMocks.runner.runMessageReceived.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("returns no suppression when no global hook runner is available", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue(null);
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);

    const result = await runMessageReceivedAdmissionHooks(admissionParams());

    expect(result).toEqual({ suppressed: false, pluginHookRan: false });
    expect(internalReceived).toHaveBeenCalledTimes(1);
  });

  it("returns suppression from message_received hooks", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue(hookRunnerMocks.runner);
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    hookRunnerMocks.runner.runMessageReceived.mockResolvedValue({
      suppress: true,
      suppressReason: "admin command",
    } as never);

    const result = await runMessageReceivedAdmissionHooks(admissionParams());

    expect(result).toMatchObject({
      suppressed: true,
      suppressReason: "admin command",
      pluginHookRan: true,
    });
    expect(hookRunnerMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "hello",
        from: "telegram:user-1",
        messageId: "msg-1",
      }),
      expect.objectContaining({
        accountId: "default",
        channelId: "telegram",
        conversationId: "telegram:user-1",
      }),
    );
  });

  it("returns content rewrites from message_received hooks", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue(hookRunnerMocks.runner);
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    hookRunnerMocks.runner.runMessageReceived.mockResolvedValue({
      content: "rewritten",
    } as never);

    const result = await runMessageReceivedAdmissionHooks(admissionParams());

    expect(result).toEqual({
      suppressed: false,
      content: "rewritten",
      pluginHookRan: true,
    });
  });

  it("logs plugin hook failures and continues non-suppressed", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue(hookRunnerMocks.runner);
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    hookRunnerMocks.runner.runMessageReceived.mockRejectedValue(new Error("boom"));
    const logger = vi.fn();

    const result = await runMessageReceivedAdmissionHooks(admissionParams({ logger }));

    expect(result).toEqual({ suppressed: false, pluginHookRan: true });
    expect(logger).toHaveBeenCalledWith("test: plugin hook failed: Error: boom");
  });

  it("fires internal message hooks independently of plugin hook failures", async () => {
    hookRunnerMocks.getGlobalHookRunner.mockReturnValue(hookRunnerMocks.runner);
    hookRunnerMocks.runner.hasHooks.mockReturnValue(true);
    hookRunnerMocks.runner.runMessageReceived.mockRejectedValue(new Error("boom"));
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);

    await runMessageReceivedAdmissionHooks(
      admissionParams({
        internalHookContext: {
          timestamp: 1710000000000,
        },
      }),
    );

    expect(internalReceived).toHaveBeenCalledTimes(1);
    expect(internalReceived.mock.calls[0]?.[0]).toMatchObject({
      type: "message",
      action: "received",
      sessionKey: "agent:main:telegram:user-1",
      context: {
        content: "hello",
        timestamp: 1710000000000,
      },
    });
  });
});
