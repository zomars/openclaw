import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn());
const getRuntimeAuthForModel = vi.hoisted(() => vi.fn());
const requireApiKey = vi.hoisted(() => vi.fn());
const buildModelAliasIndex = vi.hoisted(() => vi.fn());
const resolveDefaultModelForAgent = vi.hoisted(() => vi.fn());
const resolveModelRefFromString = vi.hoisted(() => vi.fn());
const resolveModelAsync = vi.hoisted(() => vi.fn());
const prepareModelForSimpleCompletion = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    completeSimple,
  };
});

vi.mock("../../agents/model-auth.js", () => ({ requireApiKey }));

vi.mock("../../agents/model-selection.js", () => ({
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync,
}));

vi.mock("../../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion,
}));

vi.mock("../../plugins/runtime/runtime-model-auth.runtime.js", () => ({
  getRuntimeAuthForModel,
}));

import { generateConversationLabel } from "./conversation-label-generator.js";

describe("generateConversationLabel", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    getRuntimeAuthForModel.mockReset();
    requireApiKey.mockReset();
    buildModelAliasIndex.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveModelRefFromString.mockReset();
    resolveModelAsync.mockReset();
    prepareModelForSimpleCompletion.mockReset();

    buildModelAliasIndex.mockReturnValue({ byAlias: new Map() });
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-test" });
    resolveModelAsync.mockResolvedValue({
      model: { provider: "openai" },
      authStorage: {},
      modelRegistry: {},
    });
    prepareModelForSimpleCompletion.mockImplementation(({ model }) => model);
    getRuntimeAuthForModel.mockResolvedValue({ apiKey: "resolved-key", mode: "api-key" });
    requireApiKey.mockReturnValue("resolved-key");
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "Topic label" }],
    });
  });

  it("uses routed agentDir for model and auth resolution", async () => {
    await generateConversationLabel({
      userMessage: "Need help with invoices",
      prompt: "prompt",
      cfg: {},
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
    });

    expect(resolveDefaultModelForAgent).toHaveBeenCalledWith({
      cfg: {},
      agentId: "billing",
    });
    expect(resolveModelRefFromString).not.toHaveBeenCalled();
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-test",
      "/tmp/agents/billing/agent",
      {},
    );
    expect(getRuntimeAuthForModel).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
      workspaceDir: "/tmp/agents/billing/agent",
    });
    expect(prepareModelForSimpleCompletion).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
    });
  });

  it("uses an explicit model override instead of the routed agent default", async () => {
    resolveModelRefFromString.mockReturnValue({
      ref: { provider: "ollama", model: "deepseek-v4-flash:cloud" },
      alias: "ds-flash",
    });

    await generateConversationLabel({
      userMessage: "Necesito ayuda con facturas",
      prompt: "prompt",
      cfg: {},
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
      model: "ds-flash",
    });

    expect(buildModelAliasIndex).toHaveBeenCalledWith({ cfg: {}, defaultProvider: "openai" });
    expect(resolveModelRefFromString).toHaveBeenCalledWith({
      cfg: {},
      raw: "ds-flash",
      defaultProvider: "openai",
      aliasIndex: { byAlias: new Map() },
    });
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "ollama",
      "deepseek-v4-flash:cloud",
      "/tmp/agents/billing/agent",
      {},
    );
  });
});
