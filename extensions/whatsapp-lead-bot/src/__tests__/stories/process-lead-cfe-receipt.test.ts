import { describe, it, expect } from "vitest";
import type { ParseAndQuoteError, ParseAndQuoteResult } from "../../cfe/parse-and-quote-client.js";
import {
  processLeadCFEReceiptTool,
  type ProcessLeadCFEReceiptDeps,
} from "../../tools/process-lead-cfe-receipt.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";

const CUSTOMER_PHONE = "526671234567";
const MEDIA_PATH = "/tmp/inbound-receipt.jpg";

const SAMPLE_OK: ParseAndQuoteResult = {
  success: true,
  quoteId: "q-uuid-2",
  quoteNumber: "SOL20260506-9999",
  pdfUrl: "https://example.com/quote-cust.pdf",
  quote: {
    panelCount: 10,
    cashPrice: 150000,
    listPrice: 190000,
    annualSavings: 14000,
    coveragePercent: 92,
    paybackYears: 4.8,
  },
  cfe: {
    data: {
      customerName: "ARAMBURO SANCHEZ MANUEL",
      serviceNumber: "546900701643",
      tariffType: "1F",
      annualConsumption: 9634,
    },
  },
};

interface FakeState {
  parseCalls: Array<{ mediaPath: string; phoneNumber: string }>;
  saveLeadCalls: Array<{ phone: string; name: string; notes?: string }>;
  saveQuoteIdCalls: Array<{ leadId: number; quoteId: string; quoteNumber: string }>;
  downloads: Array<{ url: string; dest: string }>;
}

function buildDeps(overrides: Partial<ProcessLeadCFEReceiptDeps> = {}): {
  deps: ProcessLeadCFEReceiptDeps;
  runtime: ReturnType<typeof createFakeRuntime>;
  state: FakeState;
} {
  const runtime = createFakeRuntime();
  const state: FakeState = {
    parseCalls: [],
    saveLeadCalls: [],
    saveQuoteIdCalls: [],
    downloads: [],
  };

  const deps: ProcessLeadCFEReceiptDeps = {
    parseAndQuote: async (input) => {
      state.parseCalls.push(input);
      return SAMPLE_OK;
    },
    saveLead: async (input) => {
      state.saveLeadCalls.push(input);
      return { leadId: 77 };
    },
    saveQuoteId: async (input) => {
      state.saveQuoteIdCalls.push(input);
    },
    downloadFile: async (url, destPath) => {
      state.downloads.push({ url, dest: destPath });
      return destPath;
    },
    runtime,
    outputDir: "/tmp/cfe-output",
    ...overrides,
  };

  return { deps, runtime, state };
}

describe("process_lead_cfe_receipt tool", () => {
  it("sends customer-friendly ack first", async () => {
    const { deps, runtime } = buildDeps();
    await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );
    expect(runtime.sentMessages[0].content.text).toMatch(/Recibí su recibo/);
    expect(runtime.sentMessages[0].to).toBe(CUSTOMER_PHONE);
  });

  it("happy path: parse-and-quote → save lead under customer phone → save quote ref → download → send", async () => {
    const { deps, runtime, state } = buildDeps();

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.leadId).toBe(77);
    expect(result.quoteId).toBe("q-uuid-2");
    expect(result.quoteNumber).toBe("SOL20260506-9999");

    expect(state.parseCalls).toEqual([{ mediaPath: MEDIA_PATH, phoneNumber: CUSTOMER_PHONE }]);
    expect(state.saveLeadCalls[0].phone).toBe(CUSTOMER_PHONE);
    expect(state.saveLeadCalls[0].name).toBe("ARAMBURO SANCHEZ MANUEL");
    expect(state.saveQuoteIdCalls[0]).toMatchObject({
      leadId: 77,
      quoteId: "q-uuid-2",
      quoteNumber: "SOL20260506-9999",
    });
    expect(state.downloads).toHaveLength(1);

    expect(runtime.sentMessages).toHaveLength(2);
    const final = runtime.sentMessages[1];
    expect(final.to).toBe(CUSTOMER_PHONE);
    expect(final.content.text).toContain("SOL20260506-9999");
    expect(final.content.text).toContain("$150,000");
    expect(final.content.metadata?.filePath).toBe(state.downloads[0].dest);
  });

  it("parseAndQuote returning error → friendly Spanish error to customer", async () => {
    const errResp: ParseAndQuoteError = { success: false, error: "form rejected" };
    const { deps, runtime, state } = buildDeps({
      parseAndQuote: async () => errResp,
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.saveLeadCalls).toHaveLength(0);
    expect(state.downloads).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda/);
  });

  it("saveLead throwing → error sent, no download", async () => {
    const { deps, runtime, state } = buildDeps({
      saveLead: async () => {
        throw new Error("db down");
      },
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.downloads).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda/);
  });

  it("downloadFile throwing → error sent without attachment", async () => {
    const { deps, runtime } = buildDeps({
      downloadFile: async () => {
        throw new Error("HTTP 500");
      },
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(runtime.sentMessages[1].content.metadata?.filePath).toBeUndefined();
  });

  it("missing customerName falls back to 'Cliente'", async () => {
    const noName: ParseAndQuoteResult = {
      ...SAMPLE_OK,
      cfe: { data: { ...SAMPLE_OK.cfe!.data!, customerName: undefined } },
    };
    const { deps, state } = buildDeps({
      parseAndQuote: async () => noName,
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(true);
    expect(state.saveLeadCalls[0].name).toBe("Cliente");
  });

  it("final send failing returns send_failed but lead preserved", async () => {
    const runtime = createFakeRuntime();
    let callCount = 0;
    runtime.sendMessage = async (to, content) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("network");
      }
      runtime.sentMessages.push({ to, content });
    };
    const { deps, state } = buildDeps({ runtime });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("send_failed");
    expect(result.leadId).toBe(77);
    expect(state.downloads).toHaveLength(1);
  });

  it("rejects empty params", async () => {
    const { deps } = buildDeps();
    const r1 = await processLeadCFEReceiptTool.execute({ mediaPath: "", customerPhone: "" }, deps);
    expect(r1.success).toBe(false);
    const r2 = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: "" },
      deps,
    );
    expect(r2.success).toBe(false);
  });
});
