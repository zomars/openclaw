import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type {
  PluginHookBeforePromptBuildResult,
  PluginHookMessageContext,
  PluginHookMessageReceivedResult,
  PluginHookRegistration,
  PluginHookToolContext,
} from "./types.js";

type AgentScope = Pick<PluginRecord, "id" | "allowAgents" | "denyAgents">;

function attachPluginRecord(registry: PluginRegistry, scope: AgentScope) {
  registry.plugins.push(
    createPluginRecord({
      id: scope.id,
      allowAgents: scope.allowAgents,
      denyAgents: scope.denyAgents,
    }),
  );
}

const inboundCtx = (agentId?: string): PluginHookMessageContext => ({
  channelId: "whatsapp",
  accountId: "solayre",
  agentId,
});

const toolCtx = (agentId: string): PluginHookToolContext => ({
  toolName: "bash",
  agentId,
  sessionKey: `agent:${agentId}:default`,
});

describe("plugin agent scoping at the hook dispatcher", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("fires message_received only when the plugin's allowAgents matches the route agent", async () => {
    const handler = vi.fn(
      (): PluginHookMessageReceivedResult => ({ suppress: true, suppressReason: "test" }),
    );
    attachPluginRecord(registry, {
      id: "whatsapp-lead-bot",
      allowAgents: ["solayre-leads"],
    });
    addTestHook({
      registry,
      pluginId: "whatsapp-lead-bot",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    const allowed = await runner.runMessageReceived(
      { from: "+5215555555555", content: "hi" },
      inboundCtx("solayre-leads"),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(allowed?.suppress).toBe(true);

    handler.mockClear();

    const denied = await runner.runMessageReceived(
      { from: "+5215555555555", content: "hi" },
      inboundCtx("solayre-coworker"),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(denied).toBeUndefined();
  });

  it("treats a missing allowAgents on a plugin record as strict opt-in (no hooks fire)", async () => {
    const handler = vi.fn();
    attachPluginRecord(registry, { id: "noisy-plugin" });
    addTestHook({
      registry,
      pluginId: "noisy-plugin",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx("solayre-leads"),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats an empty allowAgents as strict opt-in (no hooks fire)", async () => {
    const handler = vi.fn();
    attachPluginRecord(registry, { id: "empty-plugin", allowAgents: [] });
    addTestHook({
      registry,
      pluginId: "empty-plugin",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx("solayre-leads"),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("honors denyAgents on top of allowAgents", async () => {
    const handler = vi.fn();
    attachPluginRecord(registry, {
      id: "scoped",
      allowAgents: ["solayre-leads", "solayre-coworker"],
      denyAgents: ["solayre-coworker"],
    });
    addTestHook({
      registry,
      pluginId: "scoped",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx("solayre-coworker"),
    );
    expect(handler).not.toHaveBeenCalled();

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx("solayre-leads"),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips hooks when the route did not resolve an agentId", async () => {
    const handler = vi.fn();
    attachPluginRecord(registry, { id: "scoped", allowAgents: ["solayre-leads"] });
    addTestHook({
      registry,
      pluginId: "scoped",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx(undefined),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("filters before_tool_call hooks by plugin allowAgents", async () => {
    const leadHandler = vi.fn();
    const coworkerHandler = vi.fn();
    attachPluginRecord(registry, { id: "lead-bot", allowAgents: ["solayre-leads"] });
    attachPluginRecord(registry, { id: "co-bot", allowAgents: ["solayre-coworker"] });
    addTestHook({
      registry,
      pluginId: "lead-bot",
      hookName: "before_tool_call",
      handler: leadHandler as PluginHookRegistration["handler"],
    });
    addTestHook({
      registry,
      pluginId: "co-bot",
      hookName: "before_tool_call",
      handler: coworkerHandler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runBeforeToolCall({ toolName: "bash", params: {} }, toolCtx("solayre-leads"));
    expect(leadHandler).toHaveBeenCalledTimes(1);
    expect(coworkerHandler).not.toHaveBeenCalled();
  });

  it("filters before_prompt_build hooks by plugin allowAgents", async () => {
    const handler = vi.fn(
      (): PluginHookBeforePromptBuildResult => ({ prependSystemContext: "leads" }),
    );
    attachPluginRecord(registry, { id: "lead-bot", allowAgents: ["solayre-leads"] });
    addTestHook({
      registry,
      pluginId: "lead-bot",
      hookName: "before_prompt_build",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runBeforePromptBuild(
      { prompt: "stub", messages: [] },
      {
        runId: "r1",
        agentId: "solayre-coworker",
        sessionKey: "agent:solayre-coworker:default",
        sessionId: "s1",
        workspaceDir: "/tmp",
        messageProvider: "test",
      },
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not filter gateway-wide hooks whose context has no agentId field", async () => {
    const handler = vi.fn();
    attachPluginRecord(registry, { id: "memory-core" }); // no allowAgents = strict opt-in
    addTestHook({
      registry,
      pluginId: "memory-core",
      hookName: "gateway_start",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);
    // gateway_start context has no `agentId` field, so the filter must not
    // strip the hook just because allowAgents is missing.
    await runner.runGatewayStart(
      { reason: "manual" },
      {
        startedAt: new Date().toISOString(),
        gatewayVersion: "test",
        sessionsDir: "/tmp",
      },
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets test fixtures with empty registry.plugins keep firing hooks (no records = no filtering)", async () => {
    const handler = vi.fn();
    addTestHook({
      registry,
      pluginId: "untracked-plugin",
      hookName: "message_received",
      handler: handler as PluginHookRegistration["handler"],
    });
    const runner = createHookRunner(registry);

    await runner.runMessageReceived(
      { from: "+5215551112222", content: "hi" },
      inboundCtx("solayre-leads"),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
