import { describe, expect, it } from "vitest";
import { createFakeRuntime } from "../__tests__/helpers/fake-runtime.js";
import { createTestDb } from "../__tests__/helpers/tmp-db.js";
import { InMemoryLeadEventLog } from "../crm-memory/lead-events.js";
import type { PendingQuoteJobStore } from "../database.js";
import type { DeliveredQuoteAccess } from "../database.js";
import type { PendingQuoteJob } from "../database/schema.js";
import { processLeadCFEReceiptTool } from "../tools/process-lead-cfe-receipt.js";
import type { ParseAndQuoteResult, QuoteRequestCheckResult } from "./parse-and-quote-client.js";
import type { QuoteAccessTokenResult } from "./quote-access-client.js";
import { QuoteDeliveryWorker } from "./quote-delivery-worker.js";

const SAMPLE_OK: ParseAndQuoteResult = {
  success: true,
  quoteId: "quote_0de2",
  quoteNumber: "SOL20260618-0de2",
  pdfUrl: "https://example.com/SOL20260618-0de2.pdf",
  quote: {
    panelCount: 7,
    cashPrice: 73549.35,
    listPrice: 82000,
    annualSavings: 16400,
    coveragePercent: 96,
    paybackYears: 4.48,
    systemKw: 4.515,
    panelWattage: 645,
    financedPrice: 82000,
    fomo25Years: 512000,
    roi25YearsPercent: 610,
  },
  cfe: {
    data: {
      customerName: "VILLARREAL ZUNIGA SERGIO ARTURO",
      serviceNumber: "533100700148",
      tariffType: "1D",
      annualConsumption: 8355,
    },
  },
};

class MemoryPendingQuoteStore implements PendingQuoteJobStore {
  jobs: PendingQuoteJob[];

  constructor(job: PendingQuoteJob) {
    this.jobs = [job];
  }

  async createPendingQuoteJob(): Promise<number> {
    throw new Error("not used");
  }

  async findPendingQuoteJobByCustomerMedia(): Promise<PendingQuoteJob | null> {
    return null;
  }

  async getDuePendingQuoteJobs(now: number, limit: number): Promise<PendingQuoteJob[]> {
    return this.jobs
      .filter(
        (job) => job.status === "pending" && job.next_poll_at <= now && !job.webhook_resumed_at,
      )
      .slice(0, limit);
  }

  async getPendingQuoteJobByRequestId(requestId: string): Promise<PendingQuoteJob | null> {
    return this.jobs.find((candidate) => candidate.request_id === requestId) ?? null;
  }

  async markPendingQuoteJobWebhookResumed(id: number, resumedAt = Date.now()): Promise<boolean> {
    const job = this.requireJob(id);
    if (job.status !== "pending" || job.webhook_resumed_at) {
      return false;
    }
    job.webhook_resumed_at = resumedAt;
    return true;
  }

  async reschedulePendingQuoteJob(
    id: number,
    input: { attempts: number; nextPollAt: number; lastError?: string | null },
  ): Promise<void> {
    const job = this.requireJob(id);
    job.attempts = input.attempts;
    job.next_poll_at = input.nextPollAt;
    job.last_error = input.lastError ?? null;
  }

  async markPendingQuoteJobDelivered(
    id: number,
    input: {
      attempts: number;
      quoteId: string;
      quoteNumber: string;
      quoteAccess?: QuoteAccessTokenResult | null;
    },
  ): Promise<void> {
    const job = this.requireJob(id);
    job.status = "delivered";
    job.attempts = input.attempts;
    job.quote_id = input.quoteId;
    job.quote_number = input.quoteNumber;
    job.quote_access_token_id = input.quoteAccess?.tokenId ?? null;
    job.quote_access_url = input.quoteAccess?.url ?? null;
    job.quote_access_expires_at = input.quoteAccess?.expiresAt ?? null;
    job.completed_at = Date.now();
  }

  async getLatestDeliveredQuoteAccess(): Promise<DeliveredQuoteAccess | null> {
    return null;
  }

  async markPendingQuoteJobFailed(
    id: number,
    input: {
      attempts: number;
      error: string;
      quoteId?: string | null;
      quoteNumber?: string | null;
    },
  ): Promise<void> {
    const job = this.requireJob(id);
    job.status = "failed";
    job.attempts = input.attempts;
    job.last_error = input.error;
    job.quote_id = input.quoteId ?? null;
    job.quote_number = input.quoteNumber ?? null;
    job.completed_at = Date.now();
  }

  private requireJob(id: number): PendingQuoteJob {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new Error(`job ${id} not found`);
    }
    return job;
  }
}

describe("QuoteDeliveryWorker", () => {
  it("runs receipt submission -> persisted pending job -> worker delivery end to end", async () => {
    let now = 1000;
    const { db } = createTestDb();
    const runtime = createFakeRuntime();
    const downloads: Array<{ url: string; destPath: string }> = [];
    const checks: QuoteRequestCheckResult[] = [
      { success: true, status: "processing" },
      { success: true, status: "done", result: SAMPLE_OK },
    ];

    const queued = await processLeadCFEReceiptTool.execute(
      { mediaPath: "/tmp/sergio-recibo.pdf", customerPhone: "526121347942" },
      {
        submitReceipt: async (input) => {
          expect(input).toEqual({
            mediaPath: "/tmp/sergio-recibo.pdf",
            phoneNumber: "526121347942",
          });
          return { success: true, requestId: "req_sergio" };
        },
        createPendingQuoteJob: (input) => db.createPendingQuoteJob({ ...input, nextPollAt: now }),
        nextPollDelayMs: 0,
        runtime,
      },
    );

    expect(queued).toMatchObject({
      success: true,
      mode: "queued",
      requestId: "req_sergio",
    });
    expect(runtime.sentMessages).toHaveLength(1);
    expect(runtime.sentMessages[0]).toMatchObject({
      to: "526121347942",
      content: { metadata: { source: "process_lead_cfe_receipt:ack" } },
    });

    const worker = new QuoteDeliveryWorker(
      {
        store: db,
        checkRequest: async (requestId) => {
          expect(requestId).toBe("req_sergio");
          return checks.shift() ?? { success: true, status: "processing" };
        },
        saveLead: async (input) => {
          const lead = await db.upsertLead(input.phone, { name: input.name, notes: input.notes });
          return { leadId: lead.id };
        },
        saveQuoteId: async (input) => {
          await db.updateQuoteData(input.leadId, {
            notes: JSON.stringify({ quoteId: input.quoteId, quoteNumber: input.quoteNumber }),
            quoted_at: now,
          });
        },
        downloadFile: async (url, destPath) => {
          downloads.push({ url, destPath });
          return destPath;
        },
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        pollIntervalMs: 30_000,
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();
    const rescheduled = await db.getDuePendingQuoteJobs(now, 10);
    expect(rescheduled).toHaveLength(0);
    expect(runtime.sentMessages).toHaveLength(1);

    now += 30_000;
    await worker.pollOnce();

    expect(downloads).toEqual([
      expect.objectContaining({ url: "https://example.com/SOL20260618-0de2.pdf" }),
    ]);
    expect(runtime.sentMessages).toHaveLength(2);
    const delivered = runtime.sentMessages[1];
    expect(delivered.to).toBe("526121347942");
    expect(delivered.content.text).toContain("En su medidor 533100700148");
    expect(delivered.content.metadata?.filePath).toContain("cotizacion-");

    const pendingAgain = await db.getDuePendingQuoteJobs(now + 60_000, 10);
    expect(pendingAgain).toHaveLength(0);
  });

  it("reschedules pending Lovable requests and delivers when done", async () => {
    let now = 1000;
    const runtime = createFakeRuntime();
    const store = new MemoryPendingQuoteStore({
      id: 1,
      request_id: "req_sergio",
      customer_phone: "526121347942",
      media_path: "/tmp/sergio.pdf",
      status: "pending",
      attempts: 0,
      next_poll_at: now,
      last_error: null,
      quote_id: null,
      quote_number: null,
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
    const checks: QuoteRequestCheckResult[] = [
      { success: true, status: "processing" },
      { success: true, status: "done", result: SAMPLE_OK },
    ];
    const downloads: Array<{ url: string; destPath: string }> = [];

    const worker = new QuoteDeliveryWorker(
      {
        store,
        checkRequest: async () => checks.shift() ?? { success: true, status: "processing" },
        quoteAccess: {
          createQuoteToken: async ({ quoteNumber }) => ({
            tokenId: "qat_123",
            url: `https://solayre.lovable.app/q/token-for-${quoteNumber}`,
            expiresAt: 1_800_000,
          }),
        },
        saveLead: async () => ({ leadId: 77 }),
        saveQuoteId: async () => {},
        downloadFile: async (url, destPath) => {
          downloads.push({ url, destPath });
          return destPath;
        },
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        pollIntervalMs: 30_000,
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();
    expect(store.jobs[0].status).toBe("pending");
    expect(store.jobs[0].attempts).toBe(1);
    expect(runtime.sentMessages).toHaveLength(0);

    now += 30_000;
    await worker.pollOnce();
    expect(store.jobs[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
      quote_id: "quote_0de2",
      quote_number: "SOL20260618-0de2",
      quote_access_token_id: "qat_123",
      quote_access_url: "https://solayre.lovable.app/q/token-for-SOL20260618-0de2",
      quote_access_expires_at: 1_800_000,
    });
    expect(downloads[0].url).toBe(SAMPLE_OK.pdfUrl);
    expect(runtime.sentMessages[0].to).toBe("526121347942");
    expect(runtime.sentMessages[0].content.metadata?.filePath).toContain("cotizacion-77-");
  });

  it("appends quote.delivered CRM memory events when event writes are enabled", async () => {
    const now = 1000;
    const runtime = createFakeRuntime();
    const eventLog = new InMemoryLeadEventLog();
    const store = new MemoryPendingQuoteStore({
      id: 1,
      request_id: "req_sergio",
      customer_phone: "+52 612 134 7942",
      media_path: "/tmp/sergio.pdf",
      status: "pending",
      attempts: 2,
      next_poll_at: now,
      last_error: null,
      quote_id: null,
      quote_number: null,
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    const worker = new QuoteDeliveryWorker(
      {
        store,
        eventLog,
        config: {
          crmMemory: {
            enabled: true,
            eventWritesEnabled: true,
          },
        },
        checkRequest: async () => ({ success: true, status: "done", result: SAMPLE_OK }),
        quoteAccess: {
          createQuoteToken: async ({ quoteNumber }) => ({
            tokenId: "qat_123",
            url: `https://solayre.lovable.app/q/token-for-${quoteNumber}`,
            expiresAt: 1_800_000,
          }),
        },
        saveLead: async () => ({ leadId: 77 }),
        saveQuoteId: async () => {},
        downloadFile: async (_url, destPath) => destPath,
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();

    expect(eventLog.read("whatsapp:526121347942")).toEqual([
      expect.objectContaining({
        id: "evt-1000-whatsapp-526121347942-1",
        type: "quote.delivered",
        actor: "system",
        source: expect.objectContaining({
          channel: "system",
          toolName: "quote-delivery-worker",
        }),
        payload: {
          requestId: "req_sergio",
          jobId: 1,
          attempts: 3,
          quoteId: "quote_0de2",
          quoteNumber: "SOL20260618-0de2",
          quoteAccessUrl: "https://solayre.lovable.app/q/token-for-SOL20260618-0de2",
          error: null,
        },
      }),
    ]);
  });

  it("appends quote.failed CRM memory events when terminal quote checks fail", async () => {
    const now = 1000;
    const runtime = createFakeRuntime();
    const eventLog = new InMemoryLeadEventLog();
    const store = new MemoryPendingQuoteStore({
      id: 1,
      request_id: "req_missing",
      customer_phone: "526121347942",
      media_path: "/tmp/sergio.pdf",
      status: "pending",
      attempts: 0,
      next_poll_at: now,
      last_error: null,
      quote_id: null,
      quote_number: null,
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    const worker = new QuoteDeliveryWorker(
      {
        store,
        eventLog,
        config: {
          crmMemory: {
            enabled: true,
            eventWritesEnabled: true,
          },
        },
        checkRequest: async () => ({ success: false, error: "request not found" }),
        saveLead: async () => ({ leadId: 77 }),
        saveQuoteId: async () => {},
        downloadFile: async (_url, destPath) => destPath,
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();

    expect(store.jobs[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "request not found",
    });
    expect(eventLog.read("whatsapp:526121347942")).toEqual([
      expect.objectContaining({
        type: "quote.failed",
        payload: {
          requestId: "req_missing",
          jobId: 1,
          attempts: 1,
          quoteId: null,
          quoteNumber: null,
          quoteAccessUrl: null,
          error: "request not found",
        },
      }),
    ]);
  });

  it("does not append CRM memory events when event writes are disabled", async () => {
    const now = 1000;
    const runtime = createFakeRuntime();
    const eventLog = new InMemoryLeadEventLog();
    const store = new MemoryPendingQuoteStore({
      id: 1,
      request_id: "req_sergio",
      customer_phone: "526121347942",
      media_path: "/tmp/sergio.pdf",
      status: "pending",
      attempts: 0,
      next_poll_at: now,
      last_error: null,
      quote_id: null,
      quote_number: null,
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    const worker = new QuoteDeliveryWorker(
      {
        store,
        eventLog,
        config: {
          crmMemory: {
            enabled: true,
            eventWritesEnabled: false,
          },
        },
        checkRequest: async () => ({ success: true, status: "done", result: SAMPLE_OK }),
        saveLead: async () => ({ leadId: 77 }),
        saveQuoteId: async () => {},
        downloadFile: async (_url, destPath) => destPath,
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();

    expect(store.jobs[0].status).toBe("delivered");
    expect(eventLog.read("whatsapp:526121347942")).toEqual([]);
  });

  it("continues PDF delivery when shadow quote URL creation fails", async () => {
    const now = 1000;
    const runtime = createFakeRuntime();
    const store = new MemoryPendingQuoteStore({
      id: 1,
      request_id: "req_sergio",
      customer_phone: "526121347942",
      media_path: "/tmp/sergio.pdf",
      status: "pending",
      attempts: 0,
      next_poll_at: now,
      last_error: null,
      quote_id: null,
      quote_number: null,
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    const worker = new QuoteDeliveryWorker(
      {
        store,
        checkRequest: async () => ({ success: true, status: "done", result: SAMPLE_OK }),
        quoteAccess: {
          createQuoteToken: async () => {
            throw new Error("token service unavailable");
          },
        },
        saveLead: async () => ({ leadId: 77 }),
        saveQuoteId: async () => {},
        downloadFile: async (_url, destPath) => destPath,
        runtime,
        outputDir: "/tmp/cfe-output",
        agentPhones: ["526001112233"],
      },
      {
        pollIntervalMs: 30_000,
        requestWaitMs: 0,
        now: () => now,
      },
    );

    await worker.pollOnce();

    expect(store.jobs[0]).toMatchObject({
      status: "delivered",
      quote_access_token_id: null,
      quote_access_url: null,
      quote_access_expires_at: null,
    });
    expect(runtime.sentMessages[0].to).toBe("526121347942");
  });
});
