import { describe, it, expect } from "vitest";
import {
  sendQuoteSequenceTool,
  type QuoteCalculator,
  type QuoteResult,
} from "../../tools/send-quote-sequence.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestDb } from "../helpers/tmp-db.js";

const SAMPLE_QUOTE: QuoteResult = {
  serviceNumber: "123456789012",
  annualCost: 22000,
  twentyFiveYearProjection: 550000,
  coveragePercent: 95,
  cashPrice: 180000,
  depositPrice: 90000,
  financedPrice: 220000,
  annualSavings: 20000,
  paybackYears: 4.2,
  panelCount: 12,
  pdfUrl: "/tmp/cotizacion.pdf",
};

function ctx(overrides: Partial<QuoteResult> = {}, calcOverride?: QuoteCalculator) {
  const { db } = createTestDb();
  const runtime = createFakeRuntime();
  const calculate: QuoteCalculator =
    calcOverride ??
    (async () => ({ success: true, quote: { ...SAMPLE_QUOTE, ...overrides } }));
  return { db, runtime, calculate, interMessageDelayMs: 0 };
}

describe("send_quote_sequence tool", () => {
  it("sends 6 messages with the canonical templates and exact API numbers", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000040", { name: "Pedro" });

    const result = await sendQuoteSequenceTool.execute(
      { phone: "526671000040", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages).toHaveLength(6);

    expect(c.runtime.sentMessages[0].content.text).toContain("123456789012");
    expect(c.runtime.sentMessages[0].content.text).toContain("$22,000");

    expect(c.runtime.sentMessages[1].content.text).toContain("$550,000");
    expect(c.runtime.sentMessages[1].content.text).toContain("25 años");

    expect(c.runtime.sentMessages[2].content.text).toContain("95%");
    expect(c.runtime.sentMessages[2].content.text).toContain("Paneles solares bifaciales");

    expect(c.runtime.sentMessages[3].content.text).toContain("$180,000");
    expect(c.runtime.sentMessages[3].content.text).toContain("$90,000");
    expect(c.runtime.sentMessages[3].content.text).toContain("$220,000");
    expect(c.runtime.sentMessages[3].content.text).toContain("24 meses");

    expect(c.runtime.sentMessages[4].content.text).toContain("PDF");
    expect(c.runtime.sentMessages[4].content.metadata?.filePath).toBe("/tmp/cotizacion.pdf");

    expect(c.runtime.sentMessages[5].content.text).toContain("$20,000");
    expect(c.runtime.sentMessages[5].content.text).toContain("4.2");
  });

  it("never mentions MSI or 'meses sin intereses'", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000041", {});
    await sendQuoteSequenceTool.execute(
      { phone: "526671000041", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );
    const allText = c.runtime.sentMessages.map((m) => m.content.text).join(" ");
    expect(allText).not.toMatch(/sin\s+intereses/i);
    expect(allText).not.toMatch(/\bMSI\b/);
  });

  it("atomically updates lead with quoted system size and prices", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000042", { name: "Lucia" });

    await sendQuoteSequenceTool.execute(
      { phone: "526671000042", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );

    const lead = await c.db.getLeadByPhone("526671000042");
    expect(lead!.panels_quoted).toBe(12);
    expect(lead!.quote_cash).toBe(180000);
    expect(lead!.quote_financed).toBe(220000);
    expect(lead!.status).toBe("qualified");
  });

  it("step 5 still sends as text-only when pdfUrl is null", async () => {
    const c = ctx({ pdfUrl: null });
    await c.db.upsertLead("526671000043", {});

    await sendQuoteSequenceTool.execute(
      { phone: "526671000043", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );

    expect(c.runtime.sentMessages).toHaveLength(6);
    expect(c.runtime.sentMessages[4].content.metadata?.filePath).toBeUndefined();
  });

  it("returns error and sends nothing when calculator fails", async () => {
    const c = ctx({}, async () => ({ success: false, error: "missing_fields" }));
    await c.db.upsertLead("526671000044", {});

    const result = await sendQuoteSequenceTool.execute(
      { phone: "526671000044", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_fields");
    expect(c.runtime.sentMessages).toHaveLength(0);

    const lead = await c.db.getLeadByPhone("526671000044");
    expect(lead!.panels_quoted).toBeNull();
  });

  it("returns error when lead not found", async () => {
    const c = ctx();
    const result = await sendQuoteSequenceTool.execute(
      { phone: "999999999999", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );
    expect(result.success).toBe(false);
    expect(c.runtime.sentMessages).toHaveLength(0);
  });

  it("messages 1-4 and 6 are pricing — every step contains numeric data the LLM cannot fabricate", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000045", {});

    await sendQuoteSequenceTool.execute(
      { phone: "526671000045", billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      c,
    );

    const pricingSteps = [0, 1, 3, 5];
    for (const i of pricingSteps) {
      expect(c.runtime.sentMessages[i].content.text).toMatch(/\$[\d,]+|\d+\s*años?/);
    }
  });
});
