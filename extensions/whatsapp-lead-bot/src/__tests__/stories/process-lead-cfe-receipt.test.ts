import { describe, it, expect } from "vitest";
import type { ParseAndQuoteError, ParseAndQuoteResult } from "../../cfe/parse-and-quote-client.js";
import {
  deliverLeadCFEQuote,
  processLeadCFEReceiptTool,
  type DeliverLeadCFEQuoteDeps,
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
    systemKw: 5.5,
    panelWattage: 550,
    financedPrice: 190000,
    fomo25Years: 350000,
    roi25YearsPercent: 233,
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
  submitCalls: Array<{ mediaPath: string; phoneNumber: string }>;
  pendingJobs: Array<{
    requestId: string;
    customerPhone: string;
    mediaPath: string;
    agentSessionKey?: string | null;
    agentSessionId?: string | null;
    invokingAgentId?: string | null;
    nextPollAt?: number;
  }>;
  saveLeadCalls: Array<{ phone: string; name: string; notes?: string }>;
  saveQuoteIdCalls: Array<{ leadId: number; quoteId: string; quoteNumber: string }>;
  downloads: Array<{ url: string; dest: string }>;
}

function buildQueueDeps(overrides: Partial<ProcessLeadCFEReceiptDeps> = {}): {
  deps: ProcessLeadCFEReceiptDeps;
  runtime: ReturnType<typeof createFakeRuntime>;
  state: FakeState;
} {
  const runtime = createFakeRuntime();
  const state: FakeState = {
    submitCalls: [],
    pendingJobs: [],
    saveLeadCalls: [],
    saveQuoteIdCalls: [],
    downloads: [],
  };

  const deps: ProcessLeadCFEReceiptDeps = {
    submitReceipt: async (input) => {
      state.submitCalls.push(input);
      return { success: true, requestId: "req_123" };
    },
    createPendingQuoteJob: async (input) => {
      state.pendingJobs.push(input);
      return 42;
    },
    runtime,
    ...overrides,
  };

  return { deps, runtime, state };
}

function buildDeliveryDeps(overrides: Partial<DeliverLeadCFEQuoteDeps> = {}): {
  deps: DeliverLeadCFEQuoteDeps;
  runtime: ReturnType<typeof createFakeRuntime>;
  state: FakeState;
} {
  const runtime = createFakeRuntime();
  const state: FakeState = {
    submitCalls: [],
    pendingJobs: [],
    saveLeadCalls: [],
    saveQuoteIdCalls: [],
    downloads: [],
  };

  const deps: DeliverLeadCFEQuoteDeps = {
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
  it("sends customer-friendly ack first and queues the async quote request", async () => {
    const { deps, runtime, state } = buildQueueDeps();
    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      mode: "queued",
      requestId: "req_123",
      jobId: 42,
    });
    expect(runtime.sentMessages[0].content.text).toMatch(/Recibí su recibo/);
    expect(runtime.sentMessages[0].to).toBe(CUSTOMER_PHONE);
    expect(state.submitCalls).toEqual([{ mediaPath: MEDIA_PATH, phoneNumber: CUSTOMER_PHONE }]);
    expect(state.pendingJobs[0]).toMatchObject({
      requestId: "req_123",
      customerPhone: CUSTOMER_PHONE,
      mediaPath: MEDIA_PATH,
    });
  });

  it("does not send duplicate ack or resubmit when the same receipt already has a pending job", async () => {
    const { deps, runtime, state } = buildQueueDeps({
      findPendingQuoteJobByCustomerMedia: async () => ({
        id: 99,
        request_id: "req_existing",
        customer_phone: CUSTOMER_PHONE,
        media_path: MEDIA_PATH,
        status: "pending",
        attempts: 0,
        next_poll_at: Date.now(),
        webhook_resumed_at: null,
        last_error: null,
        quote_id: null,
        quote_number: null,
        quote_access_token_id: null,
        quote_access_url: null,
        quote_access_expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: null,
      }),
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      mode: "queued",
      requestId: "req_existing",
      jobId: 99,
    });
    expect(runtime.sentMessages).toHaveLength(0);
    expect(state.submitCalls).toHaveLength(0);
    expect(state.pendingJobs).toHaveLength(0);
  });

  it("persists the originating agent session for webhook resume", async () => {
    const { deps, state } = buildQueueDeps({
      agentSessionKey: "agent:main:whatsapp:526121347942",
      agentSessionId: "session-123",
      invokingAgentId: "main",
    });

    await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(state.pendingJobs[0]).toMatchObject({
      requestId: "req_123",
      agentSessionKey: "agent:main:whatsapp:526121347942",
      agentSessionId: "session-123",
      invokingAgentId: "main",
    });
  });

  it("submitReceipt returning error sends friendly Spanish error to customer", async () => {
    const errResp: ParseAndQuoteError = { success: false, error: "form rejected" };
    const { deps, runtime, state } = buildQueueDeps({
      submitReceipt: async () => errResp,
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(state.pendingJobs).toHaveLength(0);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda/);
  });

  it("createPendingQuoteJob throwing sends friendly Spanish error to customer", async () => {
    const { deps, runtime } = buildQueueDeps({
      createPendingQuoteJob: async () => {
        throw new Error("db down");
      },
    });

    const result = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: CUSTOMER_PHONE },
      deps,
    );

    expect(result.success).toBe(false);
    expect(runtime.sentMessages[1].content.text).toMatch(/Aleyda/);
  });

  it("rejects empty params without submitting", async () => {
    const { deps, state } = buildQueueDeps();
    const r1 = await processLeadCFEReceiptTool.execute({ mediaPath: "", customerPhone: "" }, deps);
    expect(r1.success).toBe(false);
    const r2 = await processLeadCFEReceiptTool.execute(
      { mediaPath: MEDIA_PATH, customerPhone: "" },
      deps,
    );
    expect(r2.success).toBe(false);
    expect(state.submitCalls).toHaveLength(0);
  });
});

describe("deliverLeadCFEQuote", () => {
  it("happy path: save lead under customer phone -> save quote ref -> download -> send", async () => {
    const { deps, runtime, state } = buildDeliveryDeps();

    const result = await deliverLeadCFEQuote({
      customerPhone: CUSTOMER_PHONE,
      result: SAMPLE_OK,
      deps,
    });

    expect(result.success).toBe(true);
    expect(result.leadId).toBe(77);
    expect(result.quoteId).toBe("q-uuid-2");
    expect(result.quoteNumber).toBe("SOL20260506-9999");

    expect(state.saveLeadCalls[0].phone).toBe(CUSTOMER_PHONE);
    expect(state.saveLeadCalls[0].name).toBe("ARAMBURO SANCHEZ MANUEL");
    expect(state.saveQuoteIdCalls[0]).toMatchObject({
      leadId: 77,
      quoteId: "q-uuid-2",
      quoteNumber: "SOL20260506-9999",
    });
    expect(state.downloads).toHaveLength(1);

    expect(runtime.sentMessages).toHaveLength(1);
    const final = runtime.sentMessages[0];
    expect(final.to).toBe(CUSTOMER_PHONE);
    expect(final.content.text).toContain(
      "En su medidor 546900701643, el ultimo año gasto 9,634 KWh",
    );
    expect(final.content.text).toContain(
      "Para cubrir el 92% de consumo, necesitamos producir 5.5 kW de energia",
    );
    expect(final.content.text).toContain("Serían 10 paneles de 550W.");
    expect(final.content.text).toContain(
      "Si seguimos sin placas solares en 25 años pagará $350,000 de luz a la CFE.",
    );
    expect(final.content.text).toContain(
      "El precio de la plana financiada es de $190,000 hasta 4 años",
    );
    expect(final.content.text).toContain("El precio de contado es de $150,000");
    expect(final.content.text).toContain("habra recuperado el 233% de lo invertido.");
    expect(final.content.metadata?.filePath).toBe(state.downloads[0].dest);
  });

  it("missing customerName falls back to 'Cliente'", async () => {
    const noName: ParseAndQuoteResult = {
      ...SAMPLE_OK,
      cfe: { data: { ...SAMPLE_OK.cfe.data, customerName: undefined } },
    };
    const { deps, state } = buildDeliveryDeps();

    const result = await deliverLeadCFEQuote({
      customerPhone: CUSTOMER_PHONE,
      result: noName,
      deps,
    });

    expect(result.success).toBe(true);
    expect(state.saveLeadCalls[0].name).toBe("Cliente");
  });

  it("downloadFile throwing fails without sending attachment", async () => {
    const { deps, runtime } = buildDeliveryDeps({
      downloadFile: async () => {
        throw new Error("HTTP 500");
      },
    });

    const result = await deliverLeadCFEQuote({
      customerPhone: CUSTOMER_PHONE,
      result: SAMPLE_OK,
      deps,
    });

    expect(result.success).toBe(false);
    expect(runtime.sentMessages).toHaveLength(0);
  });

  it("final send failing returns send_failed but lead is preserved", async () => {
    const runtime = createFakeRuntime();
    runtime.sendMessage = async () => {
      throw new Error("network");
    };
    const { deps, state } = buildDeliveryDeps({ runtime });

    const result = await deliverLeadCFEQuote({
      customerPhone: CUSTOMER_PHONE,
      result: SAMPLE_OK,
      deps,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("send_failed");
    expect(result.leadId).toBe(77);
    expect(state.downloads).toHaveLength(1);
  });
});
