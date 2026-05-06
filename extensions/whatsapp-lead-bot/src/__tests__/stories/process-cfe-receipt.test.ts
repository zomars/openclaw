import { describe, it, expect } from "vitest";
import type { ParseAndQuoteError, ParseAndQuoteResult } from "../../cfe/parse-and-quote-client.js";
import {
  processCFEReceiptTool,
  type ProcessCFEReceiptDeps,
} from "../../tools/process-cfe-receipt.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";

const COWORKER_PHONE = "526671234567";
const MEDIA_PATH = "/tmp/inbound-receipt.jpg";

const SAMPLE_OK: ParseAndQuoteResult = {
  success: true,
  quoteId: "q-uuid-1",
  quoteNumber: "SOL20260506-1234",
  pdfUrl: "https://example.com/quote.pdf",
  quote: {
    panelCount: 12,
    cashPrice: 180000,
    financedPrice: 220000,
    annualSavings: 18000,
    coveragePercent: 95,
    paybackYears: 4.2,
  },
  cfe: {
    data: {
      customerName: "JUAN PEREZ LOPEZ",
      serviceNumber: "123456789012",
      tariffType: "1F",
      annualConsumption: 9750,
    },
  },
};

interface FakeState {
  parseCalls: Array<{ mediaPath: string; phoneNumber: string }>;
  saveLeadCalls: Array<{ phone: string; name: string; notes?: string }>;
  saveQuoteIdCalls: Array<{ leadId: number; quoteId: string; quoteNumber: string }>;
  downloads: Array<{ url: string; dest: string }>;
}

function buildDeps(overrides: Partial<ProcessCFEReceiptDeps> = {}): {
  deps: ProcessCFEReceiptDeps;
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

  const deps: ProcessCFEReceiptDeps = {
    parseAndQuote: async (input) => {
      state.parseCalls.push(input);
      return SAMPLE_OK;
    },
    saveLead: async (input) => {
      state.saveLeadCalls.push(input);
      return { leadId: 42 };
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

describe("process_cfe_receipt tool", () => {
  it("sends ack before processing", async () => {
    const { deps, runtime } = buildDeps();
    await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );
    expect(runtime.sentMessages[0].content.text).toContain("Procesando recibo");
    expect(runtime.sentMessages[0].to).toBe(COWORKER_PHONE);
  });

  it("happy path: parses, saves lead, saves quote ref, downloads PDF, sends summary + attachment", async () => {
    const { deps, runtime, state } = buildDeps();

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.leadId).toBe(42);
    expect(result.sentToCoworker).toBe(true);

    expect(state.parseCalls).toEqual([{ mediaPath: MEDIA_PATH, phoneNumber: COWORKER_PHONE }]);
    expect(state.saveLeadCalls).toEqual([
      {
        phone: COWORKER_PHONE,
        name: "JUAN PEREZ LOPEZ",
        notes: expect.stringContaining("123456789012"),
      },
    ]);
    expect(state.saveQuoteIdCalls).toEqual([
      { leadId: 42, quoteId: "q-uuid-1", quoteNumber: "SOL20260506-1234" },
    ]);
    expect(state.downloads).toHaveLength(1);
    expect(state.downloads[0].url).toBe(SAMPLE_OK.pdfUrl);

    // Two messages: ack + final
    expect(runtime.sentMessages).toHaveLength(2);
    const final = runtime.sentMessages[1];
    expect(final.to).toBe(COWORKER_PHONE);
    expect(final.content.text).toContain("JUAN PEREZ LOPEZ");
    expect(final.content.text).toContain("SOL20260506-1234");
    expect(final.content.text).toContain("$180,000");
    expect(final.content.text).toContain("$220,000");
    expect(final.content.text).toContain("$18,000");
    expect(final.content.text).toContain("4.2 años");
    expect(final.content.metadata?.filePath).toBe(state.downloads[0].dest);
  });

  it("parseAndQuote returning error → coworker informed, no lead created", async () => {
    const errResp: ParseAndQuoteError = { success: false, error: "name mismatch" };
    const { deps, runtime, state } = buildDeps({
      parseAndQuote: async () => errResp,
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.saveLeadCalls).toHaveLength(0);
    expect(state.downloads).toHaveLength(0);
    expect(runtime.sentMessages).toHaveLength(2);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda|problema/i);
  });

  it("saveLead failing → error sent, no PDF download", async () => {
    const { deps, runtime, state } = buildDeps({
      saveLead: async () => {
        throw new Error("db down");
      },
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.downloads).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda|problema/i);
  });

  it("downloadFile failing → error sent without attachment", async () => {
    const { deps, runtime } = buildDeps({
      downloadFile: async () => {
        throw new Error("HTTP 500");
      },
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
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

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(true);
    expect(state.saveLeadCalls[0].name).toBe("Cliente");
  });

  it("final send failing returns send_failed but lead is preserved", async () => {
    const runtime = createFakeRuntime();
    let callCount = 0;
    runtime.sendMessage = async (to, content) => {
      callCount++;
      // First call (ack) succeeds, second (final summary) fails.
      if (callCount === 2) {
        throw new Error("network");
      }
      runtime.sentMessages.push({ to, content });
    };
    const { deps, state } = buildDeps({ runtime });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("send_failed");
    expect(result.leadId).toBe(42);
    expect(state.downloads).toHaveLength(1);
  });

  it("rejects empty params", async () => {
    const { deps } = buildDeps();
    const r1 = await processCFEReceiptTool.execute({ mediaPath: "", coworkerPhone: "" }, deps);
    expect(r1.success).toBe(false);
    const r2 = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: "" },
      deps,
    );
    expect(r2.success).toBe(false);
    const r3 = await processCFEReceiptTool.execute(
      { mediaPath: "", coworkerPhone: COWORKER_PHONE },
      deps,
    );
    expect(r3.success).toBe(false);
  });
});
