import { describe, expect, it } from "vitest";
import {
  isPluginVisibleForAgent,
  isVisibleForAgent,
  normalizeAgentList,
} from "./agent-visibility.js";

describe("normalizeAgentList", () => {
  it("returns undefined when value is not an array", () => {
    expect(normalizeAgentList(undefined)).toBeUndefined();
    expect(normalizeAgentList(null)).toBeUndefined();
    expect(normalizeAgentList("solayre-leads")).toBeUndefined();
  });

  it("trims, lowercases, drops empties, and dedupes", () => {
    expect(normalizeAgentList(["Solayre-Leads", "solayre-leads", " ", "ALEYDA", ""])).toEqual([
      "solayre-leads",
      "aleyda",
    ]);
  });

  it("returns undefined when the array has no usable entries", () => {
    expect(normalizeAgentList([])).toBeUndefined();
    expect(normalizeAgentList([" ", ""])).toBeUndefined();
    expect(normalizeAgentList([123, null])).toBeUndefined();
  });
});

describe("isVisibleForAgent (MCP semantics — opt-out)", () => {
  it("is visible when no allow/deny constraints exist", () => {
    expect(isVisibleForAgent({}, "solayre-leads")).toBe(true);
    expect(isVisibleForAgent({}, undefined)).toBe(true);
  });

  it("requires the agent to be in allowAgents when allowAgents is set", () => {
    expect(isVisibleForAgent({ allowAgents: ["solayre-leads"] }, "solayre-leads")).toBe(true);
    expect(isVisibleForAgent({ allowAgents: ["solayre-leads"] }, "solayre-coworker")).toBe(false);
    expect(isVisibleForAgent({ allowAgents: ["solayre-leads"] }, undefined)).toBe(false);
  });

  it("hides agents listed in denyAgents", () => {
    expect(isVisibleForAgent({ denyAgents: ["solayre-finanzas"] }, "solayre-finanzas")).toBe(false);
    expect(isVisibleForAgent({ denyAgents: ["solayre-finanzas"] }, "solayre-leads")).toBe(true);
  });

  it("denyAgents subtracts from allowAgents", () => {
    expect(
      isVisibleForAgent(
        { allowAgents: ["solayre-leads", "solayre-coworker"], denyAgents: ["solayre-coworker"] },
        "solayre-coworker",
      ),
    ).toBe(false);
  });

  it("matches agents case-insensitively", () => {
    expect(isVisibleForAgent({ allowAgents: ["Solayre-Leads"] }, "solayre-leads")).toBe(true);
    expect(isVisibleForAgent({ denyAgents: ["SOLAYRE-LEADS"] }, "solayre-leads")).toBe(false);
  });

  it("supports a wildcard '*' in allowAgents to opt into every agent", () => {
    expect(isVisibleForAgent({ allowAgents: ["*"] }, "solayre-leads")).toBe(true);
    expect(isVisibleForAgent({ allowAgents: ["*"] }, "anything-else")).toBe(true);
    expect(isVisibleForAgent({ allowAgents: ["*"] }, undefined)).toBe(true);
  });

  it("still subtracts denyAgents when allowAgents is wildcard", () => {
    expect(
      isVisibleForAgent(
        { allowAgents: ["*"], denyAgents: ["solayre-finanzas"] },
        "solayre-finanzas",
      ),
    ).toBe(false);
  });
});

describe("isPluginVisibleForAgent (plugin semantics — strict opt-in)", () => {
  it("treats missing allowAgents as inert", () => {
    expect(isPluginVisibleForAgent({}, "solayre-leads")).toBe(false);
    expect(isPluginVisibleForAgent({ denyAgents: ["other"] }, "solayre-leads")).toBe(false);
  });

  it("treats an empty allowAgents array as inert", () => {
    expect(isPluginVisibleForAgent({ allowAgents: [] }, "solayre-leads")).toBe(false);
    expect(isPluginVisibleForAgent({ allowAgents: [" ", ""] }, "solayre-leads")).toBe(false);
  });

  it("admits agents listed in allowAgents", () => {
    expect(isPluginVisibleForAgent({ allowAgents: ["solayre-leads"] }, "solayre-leads")).toBe(true);
    expect(isPluginVisibleForAgent({ allowAgents: ["solayre-leads"] }, "solayre-coworker")).toBe(
      false,
    );
  });

  it("still honors denyAgents on top of allowAgents", () => {
    expect(
      isPluginVisibleForAgent(
        { allowAgents: ["solayre-leads", "solayre-coworker"], denyAgents: ["solayre-coworker"] },
        "solayre-coworker",
      ),
    ).toBe(false);
  });

  it("returns false when no agentId is provided regardless of allowAgents", () => {
    expect(isPluginVisibleForAgent({ allowAgents: ["solayre-leads"] }, undefined)).toBe(false);
  });

  it("supports a wildcard '*' in allowAgents", () => {
    expect(isPluginVisibleForAgent({ allowAgents: ["*"] }, "solayre-leads")).toBe(true);
    expect(isPluginVisibleForAgent({ allowAgents: ["*"] }, "anything-else")).toBe(true);
  });
});
