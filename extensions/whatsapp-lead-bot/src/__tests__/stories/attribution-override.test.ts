import { describe, expect, it, vi } from "vitest";
import { createAttributionOverrideHandler } from "../../hooks/attribution-override.js";
import type { PluginHookBeforeToolCallEvent } from "../../types.js";

function evt(toolName: string, params: Record<string, unknown>): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

describe("attribution-override hook", () => {
  it("overrides coworkerPhone with runtime sender for process_cfe_receipt", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(
      evt("process_cfe_receipt", {
        mediaPath: "/tmp/recibo.pdf",
        coworkerPhone: "5219999999999",
      }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818" },
    );

    expect(result).toEqual({
      params: { mediaPath: "/tmp/recibo.pdf", coworkerPhone: "5216672350818" },
    });
  });

  it("overrides customerPhone with runtime sender for process_cfe_receipt_customer", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(
      evt("process_cfe_receipt_customer", {
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
      sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818",
    });

    expect(result).toEqual({
      params: { phone: "5216672350818", name: "Juan" },
    });
  });

  it("overrides coworkerPhone for edit_quote", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(
      evt("edit_quote", { quoteNumber: "SOL20260513-2117", coworkerPhone: "5219999999999" }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818" },
    );

    expect(result).toEqual({
      params: { quoteNumber: "SOL20260513-2117", coworkerPhone: "5216672350818" },
    });
  });

  it("normalizes the leading + on both sides before comparing", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = handler(
      evt("process_cfe_receipt", {
        mediaPath: "/tmp/r.pdf",
        coworkerPhone: "+5216672350818",
      }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818" },
    );

    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns undefined when LLM phone already matches runtime sender", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = handler(
      evt("process_cfe_receipt", {
        mediaPath: "/tmp/r.pdf",
        coworkerPhone: "5216672350818",
      }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818" },
    );

    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a warning when LLM phone differs from runtime sender", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    handler(
      evt("process_cfe_receipt", {
        mediaPath: "/tmp/r.pdf",
        coworkerPhone: "5219999999999",
      }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818" },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("LLM coworkerPhone=5219999999999");
    expect(message).toContain("runtime 5216672350818");
    warn.mockRestore();
  });

  it("blocks the call when sessionKey has no direct peer", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(
      evt("process_cfe_receipt", { mediaPath: "/tmp/r.pdf", coworkerPhone: "5216672350818" }),
      { sessionKey: "agent:solayre-coworker:whatsapp:solayre:group:120363427401851619@g.us" },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("peer direct");
  });

  it("blocks the call when sessionKey is missing entirely", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(evt("save_lead", { phone: "5216672350818" }), undefined);

    expect(result?.block).toBe(true);
  });

  it("does not touch tools outside the attributed set", () => {
    const handler = createAttributionOverrideHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = handler(
      evt("message", { action: "send", target: "whatsapp:5216671234567", message: "hola" }),
      { sessionKey: "agent:solayre-leads:whatsapp:solayre:direct:5216671234567" },
    );

    expect(result).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("injects runtime phone when LLM omits the param entirely", () => {
    const handler = createAttributionOverrideHandler();
    const result = handler(evt("save_lead", { name: "Juan" }), {
      sessionKey: "agent:solayre-coworker:whatsapp:solayre:direct:5216672350818",
    });

    expect(result).toEqual({
      params: { name: "Juan", phone: "5216672350818" },
    });
  });
});
