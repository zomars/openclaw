import { describe, expect, it, vi } from "vitest";
import { createAttributionOverrideHandler } from "../../hooks/attribution-override.js";
import type { PluginHookBeforeToolCallEvent } from "../../types.js";

function evt(toolName: string, params: Record<string, unknown>): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

describe("attribution-override hook (lead-bot-owned tools)", () => {
  it("overrides customerPhone with runtime sender for process_lead_cfe_receipt", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(
      evt("process_lead_cfe_receipt", {
        mediaPath: "/tmp/r.pdf",
        customerPhone: "5219999999999",
      }),
      { sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216671234567" },
    );

    expect(result).toEqual({
      params: { mediaPath: "/tmp/r.pdf", customerPhone: "5216671234567" },
    });
  });

  it("overrides phone for save_lead", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(evt("save_lead", { phone: "5219999999999", name: "Juan" }), {
      sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216672350818",
    });

    expect(result).toEqual({
      params: { phone: "5216672350818", name: "Juan" },
    });
  });

  it("ignores tools that are not in the attribution map", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(evt("get_lead", { phone: "5219999999999" }), {
      sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216671234567",
    });

    expect(result).toBeUndefined();
  });

  it("normalizes the leading + on both sides before comparing", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = handler(
      evt("save_lead", {
        phone: "+5216672350818",
      }),
      { sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216672350818" },
    );

    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a warning when LLM phone differs from runtime sender", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    handler(
      evt("save_lead", {
        phone: "5219999999999",
      }),
      { sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216672350818" },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("LLM phone=5219999999999");
    expect(message).toContain("runtime 5216672350818");
    warn.mockRestore();
  });

  it("blocks the call when sessionKey has no direct peer", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(evt("save_lead", { phone: "5216672350818" }), {
      sessionKey: "agent:solayre-leads:whatsapp:solayre:group:120363427401851619@g.us",
    });

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
      }),
    );
  });
});
