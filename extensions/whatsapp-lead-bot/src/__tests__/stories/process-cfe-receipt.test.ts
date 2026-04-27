import { describe, it, expect } from "vitest";
import type { CFEBillData } from "../../media/cfe-api-client.js";
import {
  processCFEReceiptTool,
  type ProcessCFEReceiptDeps,
  type ParsedQuote,
} from "../../tools/process-cfe-receipt.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";

const COWORKER_PHONE = "526671234567";
const MEDIA_PATH = "/tmp/inbound-receipt.jpg";

const SAMPLE_INBOUND: CFEBillData = {
  billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  numero_servicio: "123456789012",
  nombre_titular: "JUAN PEREZ LOPEZ",
  tarifa: "1F",
  monto_pagar_mxn: 2500,
  consumo_periodo_kwh: 800,
  calculado: { promedio_anual_kwh: 9600 },
};

const SAMPLE_QUOTE: ParsedQuote = {
  pdfUrl: "https://example.com/cotizacion-abc.pdf",
  panelCount: 12,
  cashPrice: 180000,
  financedPrice: 220000,
  annualSavings: 18000,
  coveragePercent: 95,
  paybackYears: 4.2,
};

interface FakeState {
  saveLeadCalls: Array<{ phone: string; name: string; notes?: string }>;
  saveReceiptCalls: Array<{ leadId: number; tariff?: string; annualKwh?: number }>;
  calcCalls: string[];
  downloads: Array<{ url: string; dest: string }>;
  xmlCalls: Array<{ rpu: string; nombre: string }>;
}

function buildDeps(overrides: Partial<ProcessCFEReceiptDeps> = {}): {
  deps: ProcessCFEReceiptDeps;
  runtime: ReturnType<typeof createFakeRuntime>;
  state: FakeState;
} {
  const runtime = createFakeRuntime();
  const state: FakeState = {
    saveLeadCalls: [],
    saveReceiptCalls: [],
    calcCalls: [],
    downloads: [],
    xmlCalls: [],
  };

  const deps: ProcessCFEReceiptDeps = {
    parseInboundReceipt: async () => SAMPLE_INBOUND,
    downloadOfficialXml: async ({ rpu, nombre }) => {
      state.xmlCalls.push({ rpu, nombre });
      return {
        xmlPath: "/tmp/cfe_123456789012.xml",
        rpu,
        nombre,
        total: 2480,
        annualKwh: 9750,
      };
    },
    saveLead: async (input) => {
      state.saveLeadCalls.push(input);
      return { leadId: 42 };
    },
    saveReceiptData: async (input) => {
      state.saveReceiptCalls.push({
        leadId: input.leadId,
        tariff: input.tariff,
        annualKwh: input.annualKwh,
      });
    },
    calculateQuote: async (billId: string) => {
      state.calcCalls.push(billId);
      return { success: true, quote: SAMPLE_QUOTE };
    },
    downloadFile: async (url: string, destPath: string) => {
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
  it("happy path: parses, downloads XML, saves lead, calculates quote, sends attachment + summary", async () => {
    const { deps, runtime, state } = buildDeps();

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.leadId).toBe(42);
    expect(result.sentToCoworker).toBe(true);

    expect(state.xmlCalls).toEqual([{ rpu: "123456789012", nombre: "JUAN PEREZ LOPEZ" }]);
    expect(state.saveLeadCalls).toEqual([
      {
        phone: COWORKER_PHONE,
        name: "JUAN PEREZ LOPEZ",
        notes: expect.stringContaining("123456789012"),
      },
    ]);
    expect(state.saveReceiptCalls).toEqual([{ leadId: 42, tariff: "1F", annualKwh: 9750 }]);
    expect(state.calcCalls).toEqual(["a1b2c3d4-e5f6-7890-abcd-ef1234567890"]);
    expect(state.downloads).toHaveLength(1);
    expect(state.downloads[0].url).toBe(SAMPLE_QUOTE.pdfUrl);

    // Two messages: ack + final result
    expect(runtime.sentMessages).toHaveLength(2);
    expect(runtime.sentMessages[0].content.text).toContain("Procesando recibo");
    const final = runtime.sentMessages[1];
    expect(final.to).toBe(COWORKER_PHONE);
    expect(final.content.text).toContain("JUAN PEREZ LOPEZ");
    expect(final.content.text).toContain("123456789012");
    expect(final.content.text).toContain("$180,000");
    expect(final.content.text).toContain("$220,000");
    expect(final.content.text).toContain("$18,000");
    expect(final.content.text).toContain("4.2 años");
    expect(final.content.metadata?.filePath).toBe(state.downloads[0].dest);
  });

  it("uses official portal data (total + annual kWh) over inbound when both present", async () => {
    const { deps, runtime } = buildDeps();
    await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );
    const text = runtime.sentMessages[1].content.text;
    expect(text).toContain("$2,480"); // official total, not inbound 2500
    expect(text).toContain("9,750"); // official annual kwh, not inbound 9600
  });

  it("fails clearly when inbound parser cannot read the receipt", async () => {
    const { deps, runtime, state } = buildDeps({
      parseInboundReceipt: async () => ({
        error: "no_data",
        mensaje_para_lead: "ilegible",
      }),
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.saveLeadCalls).toHaveLength(0);
    expect(state.calcCalls).toHaveLength(0);
    expect(state.downloads).toHaveLength(0);
    // ack + error
    expect(runtime.sentMessages).toHaveLength(2);
    expect(runtime.sentMessages[1].content.text).toMatch(/no pude leer|más clara/i);
  });

  it("fails clearly when inbound parser succeeds but RPU/nombre/billId are missing", async () => {
    const { deps, runtime, state } = buildDeps({
      parseInboundReceipt: async () => ({
        billId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        // numero_servicio missing
        nombre_titular: "JUAN PEREZ",
      }),
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.xmlCalls).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/RPU|titular/i);
  });

  it("fails clearly when CFE portal rejects (name mismatch)", async () => {
    const { deps, runtime, state } = buildDeps({
      downloadOfficialXml: async () => {
        throw new Error("Form rejected: nombre no coincide");
      },
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.saveLeadCalls).toHaveLength(0);
    expect(state.calcCalls).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/nombre|coincide|titular/i);
  });

  it("fails clearly when calculate_quote fails — does not send any attachment", async () => {
    const { deps, runtime, state } = buildDeps({
      calculateQuote: async () => ({ success: false, error: "billId not found" }),
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.downloads).toHaveLength(0);
    // Lead WAS created (this is documented atomicity gap — quote is best-effort downstream)
    expect(state.saveLeadCalls).toHaveLength(1);
    expect(runtime.sentMessages[1].content.text).toMatch(/cotización|aleyda/i);
    // No attachment on the error message
    expect(runtime.sentMessages[1].content.metadata?.filePath).toBeUndefined();
  });

  it("fails clearly when downloading the quote PDF fails", async () => {
    const { deps, runtime, state } = buildDeps({
      downloadFile: async () => {
        throw new Error("HTTP 500");
      },
    });

    const result = await processCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, coworkerPhone: COWORKER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.calcCalls).toHaveLength(1);
    expect(runtime.sentMessages[1].content.metadata?.filePath).toBeUndefined();
  });

  it("rejects empty params", async () => {
    const { deps } = buildDeps();
    const result = await processCFEReceiptTool.execute({ mediaPath: "", coworkerPhone: "" }, deps);
    expect(result.success).toBe(false);
  });
});
