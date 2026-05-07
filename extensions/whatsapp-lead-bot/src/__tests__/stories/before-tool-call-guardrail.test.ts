import { describe, it, expect } from "vitest";
import {
  checkPricingPatterns,
  createBeforeToolCallHandler,
  extractMessageText,
} from "../../hooks/before-tool-call.js";
import type { PluginHookBeforeToolCallEvent } from "../../types.js";

function evt(toolName: string, params: Record<string, unknown>): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

describe("checkPricingPatterns", () => {
  it("flags currency amounts", () => {
    expect(checkPricingPatterns("El precio es $50,000 pesos")).toMatchObject({
      pattern: "currency_amount",
    });
    expect(checkPricingPatterns("$1,500")).toMatchObject({ pattern: "currency_amount" });
  });

  it("flags amounts with units", () => {
    expect(checkPricingPatterns("son 50,000 pesos")).toMatchObject({ pattern: "amount_with_unit" });
    expect(checkPricingPatterns("son 50.000 mxn")).toMatchObject({ pattern: "amount_with_unit" });
  });

  it("flags financing terminology", () => {
    expect(checkPricingPatterns("a 12 meses sin intereses")).toMatchObject({
      pattern: "financing_terms",
    });
    expect(checkPricingPatterns("con MSI a 24 meses")).toMatchObject({
      pattern: "financing_terms",
    });
    expect(checkPricingPatterns("le damos enganche bajo")).toMatchObject({
      pattern: "financing_terms",
    });
    expect(checkPricingPatterns("precio de contado")).toMatchObject({ pattern: "financing_terms" });
  });

  it("flags installments", () => {
    expect(checkPricingPatterns("a 12 meses")).toMatchObject({ pattern: "installments" });
    expect(checkPricingPatterns("48 quincenas")).toMatchObject({ pattern: "installments" });
  });

  it("flags panel counts", () => {
    expect(checkPricingPatterns("12 paneles")).toMatchObject({ pattern: "panel_count" });
    expect(checkPricingPatterns("8 panel")).toMatchObject({ pattern: "panel_count" });
  });

  it("flags kWh values", () => {
    expect(checkPricingPatterns("consumo de 1500 kwh")).toMatchObject({ pattern: "kwh" });
    expect(checkPricingPatterns("750 kw")).toMatchObject({ pattern: "kwh" });
  });

  it("flags percentages", () => {
    expect(checkPricingPatterns("85% de su consumo")).toMatchObject({ pattern: "percent" });
  });

  it("flags ROI mentions", () => {
    expect(checkPricingPatterns("el ROI es")).toMatchObject({ pattern: "roi" });
    expect(checkPricingPatterns("retorno de inversión a 4 años")).toMatchObject({ pattern: "roi" });
  });

  it("passes clean conversational text", () => {
    expect(checkPricingPatterns("Buen día, ¿cómo se encuentra?")).toBeNull();
    expect(checkPricingPatterns("¿Con quién tengo el gusto?")).toBeNull();
    expect(
      checkPricingPatterns("¿En qué municipio de Sinaloa se encuentra su propiedad?"),
    ).toBeNull();
    expect(checkPricingPatterns("Para cotizarle necesito ver su recibo de CFE.")).toBeNull();
  });
});

describe("extractMessageText", () => {
  it("returns text for send action", () => {
    expect(extractMessageText({ action: "send", message: "hola" })).toBe("hola");
  });

  it("defaults action to send when missing", () => {
    expect(extractMessageText({ message: "hola" })).toBe("hola");
  });

  it("returns null for non-send actions", () => {
    expect(extractMessageText({ action: "read", message: "hola" })).toBeNull();
    expect(extractMessageText({ action: "delete" })).toBeNull();
  });

  it("returns null when message is missing or empty", () => {
    expect(extractMessageText({ action: "send" })).toBeNull();
    expect(extractMessageText({ action: "send", message: "" })).toBeNull();
    expect(extractMessageText({ action: "send", message: 123 })).toBeNull();
  });
});

describe("before_tool_call guardrail handler", () => {
  it("blocks message tool with pricing in text", async () => {
    const handler = createBeforeToolCallHandler();
    const result = await handler(
      evt("message", { action: "send", target: "whatsapp:526671", message: "El total es $50,000" }),
    );
    expect(result).toMatchObject({ block: true });
    expect(result?.blockReason).toContain("process_cfe_receipt_customer");
    expect(result?.blockReason).toContain("$50,000");
  });

  it("blocks message tool with financing terms", async () => {
    const handler = createBeforeToolCallHandler();
    const result = await handler(
      evt("message", {
        action: "send",
        target: "whatsapp:526671",
        message: "a 12 meses sin intereses",
      }),
    );
    expect(result?.block).toBe(true);
  });

  it("does not block clean conversational message", async () => {
    const handler = createBeforeToolCallHandler();
    const result = await handler(
      evt("message", {
        action: "send",
        target: "whatsapp:526671",
        message: "Buen día, ¿con quién tengo el gusto?",
      }),
    );
    expect(result).toBeUndefined();
  });

  it("does not block other tools", async () => {
    const handler = createBeforeToolCallHandler();
    const result = await handler(evt("save_lead", { phone: "526671", bimonthly_bill: 2500 }));
    expect(result).toBeUndefined();
  });

  it("does not block message tool for non-send actions", async () => {
    const handler = createBeforeToolCallHandler();
    const result = await handler(
      evt("message", { action: "read", threadId: "abc", message: "$50,000" }),
    );
    expect(result).toBeUndefined();
  });

  it("dryRun mode logs but does not block", async () => {
    const handler = createBeforeToolCallHandler({ dryRun: true });
    const result = await handler(
      evt("message", {
        action: "send",
        target: "whatsapp:526671",
        message: "El total es $50,000",
      }),
    );
    expect(result).toBeUndefined();
  });
});
