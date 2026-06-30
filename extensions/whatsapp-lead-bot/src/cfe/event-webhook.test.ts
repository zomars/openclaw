import { createHmac } from "node:crypto";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import type { PendingQuoteJobStore, QuoteWebhookEventStore } from "../database.js";
import { SqliteDatabase } from "../database/connection.js";
import type { PendingQuoteJob, QuoteWebhookEventRow } from "../database/schema.js";
import {
  createQuoteEventWebhookHandler,
  verifyQuoteEventWebhookSignature,
} from "./event-webhook.js";

const SECRET = "whsec_test";
const NOW = 1_772_234_567_000;

function sign(rawBody: string, timestamp = NOW): string {
  const digest = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function eventBody(eventId = "evt_123"): string {
  return JSON.stringify({
    event_id: eventId,
    type: "calculation.completed",
    source: "solayre.parse-and-quote",
    subject: "quote_request:req_123",
    occurred_at: "2026-06-29T18:25:00Z",
    payload: {
      request_id: "req_123",
      quote_id: "quote_123",
      quote_number: "SOL20260629-test",
      pdf_url: "https://solayre.lovable.app/quotes/SOL20260629-test.pdf",
      customer_name: "Juan Perez",
      service_number: "538220809404",
      summary: "11 paneles, 105.86% de cobertura, retorno estimado de 3.69 anos.",
      quote: {
        panel_count: 11,
        cash_price: 115577.55,
        financed_price: 212850,
        annual_savings: 31314.3,
        coverage_percent: 105.86,
        payback_years: 3.69,
        system_kw: 7.095,
      },
    },
  });
}

function failedEventBody(eventId = "evt_failed_123"): string {
  return JSON.stringify({
    event_id: eventId,
    type: "calculation.failed",
    source: "solayre.parse-and-quote",
    subject: "quote_request:req_123",
    occurred_at: "2026-06-29T18:25:00Z",
    payload: {
      request_id: "req_123",
      error: "No se pudo leer el recibo CFE.",
      error_code: "receipt_unreadable",
      retryable: false,
    },
  });
}

function createRes() {
  const headers: Record<string, string> = {};
  const resObj = {
    statusCode: 0,
    headersSent: false,
    body: undefined as unknown,
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
    },
    end: vi.fn((body?: unknown) => {
      resObj.headersSent = true;
      resObj.body = body;
    }),
  };
  return {
    res: resObj as unknown as ServerResponse & { body?: unknown },
    headers,
  };
}

function createIncomingRequest(chunks: string[]) {
  const req = Readable.from(chunks) as ReturnType<typeof Readable.from> & {
    headers: Record<string, string>;
    method?: string;
    socket: { remoteAddress?: string };
  };
  req.headers = {};
  req.socket = {};
  return req;
}

function baseConfig(): WhatsAppLeadBotConfig {
  return {
    enabled: true,
    whatsappAccounts: ["default"],
    agentNumbers: [],
    dryRunPrefixes: [],
    rateLimit: {
      enabled: true,
      messagesPerHour: 10,
      windowMs: 3_600_000,
      notifyOnLimit: true,
      global: { enabled: true, maxMessagesPerHour: 1000, windowMs: 3_600_000 },
      circuitBreaker: {
        enabled: true,
        hitRateThreshold: 0.8,
        windowMs: 300_000,
        minChecks: 10,
      },
    },
    followup: {
      enabled: true,
      silenceThresholdHours: 24,
      maxFollowups: 1,
      checkIntervalMinutes: 15,
    },
    autoHandoffWhenQualified: false,
    notifyNewLeads: true,
    notifyQualified: true,
    notifyHandoff: true,
    labels: {
      scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
      statuses: { BOT: "BOT", HUMANO: "HUMANO" },
      tags: { FUERA_DE_AREA: "Fuera de área" },
    },
    parseAndQuoteUrl: "https://example.com/parse-and-quote",
    editQuoteUrl: "https://example.com/calculate-quote",
    quoteAccess: {
      enabled: true,
      createTokenUrl: "https://example.com/create-quote-token",
      publicBaseUrl: "https://example.com",
      expiresInDays: 30,
    },
    eventWebhook: {
      enabled: true,
      path: "/plugins/whatsapp-lead-bot/quote-events",
      signingSecret: SECRET,
      replayWindowMs: 300_000,
      maxBodyBytes: 64 * 1024,
      rateLimit: { maxRequests: 120, windowMs: 60_000 },
    },
    crmSync: {
      enabled: true,
      pushEnabled: true,
      pullEnabled: false,
      saveLeadUrl: "https://example.com/save-lead",
      listLeadsUrl: "https://example.com/list-leads",
      pushIntervalMs: 60_000,
      pullIntervalMs: 120_000,
      batchSize: 25,
      maxAttempts: 12,
    },
    crmMemory: {
      enabled: false,
      mirrorEnabled: false,
      eventWritesEnabled: false,
      contextReadsEnabled: false,
      cronGateEnabled: false,
      adminStatusEnabled: false,
    },
  };
}

function createPendingJob(overrides: Partial<PendingQuoteJob> = {}): PendingQuoteJob {
  return {
    id: 99,
    request_id: "req_123",
    customer_phone: "526121347942",
    media_path: "/tmp/receipt.pdf",
    agent_session_key: "agent:main:whatsapp:526121347942",
    agent_session_id: "session-123",
    invoking_agent_id: "main",
    status: "pending",
    attempts: 0,
    next_poll_at: NOW,
    webhook_resumed_at: null,
    last_error: null,
    quote_id: null,
    quote_number: null,
    quote_access_token_id: null,
    quote_access_url: null,
    quote_access_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

function createStore(): QuoteWebhookEventStore &
  PendingQuoteJobStore & { calls: unknown[]; jobs: PendingQuoteJob[] } {
  const seen = new Set<string>();
  const calls: unknown[] = [];
  const jobs = [createPendingJob()];
  return {
    calls,
    jobs,
    async createPendingQuoteJob() {
      throw new Error("not used");
    },
    async getDuePendingQuoteJobs() {
      return [];
    },
    async getPendingQuoteJobByRequestId(requestId) {
      return jobs.find((job) => job.request_id === requestId) ?? null;
    },
    async markPendingQuoteJobWebhookResumed(id, resumedAt = NOW) {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.status !== "pending" || job.webhook_resumed_at != null) {
        return false;
      }
      job.webhook_resumed_at = resumedAt;
      return true;
    },
    async reschedulePendingQuoteJob() {},
    async markPendingQuoteJobDelivered() {},
    async markPendingQuoteJobFailed() {},
    async recordQuoteWebhookEvent(input) {
      calls.push(input);
      const duplicate = seen.has(`${input.source}:${input.eventId}`);
      seen.add(`${input.source}:${input.eventId}`);
      return {
        duplicate,
        row: {
          id: 1,
          source: input.source,
          event_id: input.eventId,
          event_type: input.eventType,
          request_id: input.requestId ?? null,
          subject: input.subject ?? null,
          payload_json: JSON.stringify(input.payload),
          status: "accepted",
          duplicate_count: duplicate ? 1 : 0,
          first_received_at: input.receivedAt ?? NOW,
          last_received_at: input.receivedAt ?? NOW,
          processed_at: null,
          last_error: null,
        } satisfies QuoteWebhookEventRow,
      };
    },
  };
}

async function invoke(params: {
  body: string;
  signature?: string;
  store?: QuoteWebhookEventStore & PendingQuoteJobStore;
  sessionWorkflow?: Parameters<typeof createQuoteEventWebhookHandler>[0]["sessionWorkflow"];
}) {
  const req = createIncomingRequest([params.body]);
  req.method = "POST";
  req.headers = {
    "content-type": "application/json",
    ...(params.signature ? { "x-openclaw-signature": params.signature } : {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as never;
  const { res } = createRes();
  const store = params.store ?? createStore();
  const handler = createQuoteEventWebhookHandler({
    cfg: { gateway: {} } as never,
    pluginConfig: baseConfig(),
    store,
    sessionWorkflow: params.sessionWorkflow,
    now: () => NOW,
    log: { warn: vi.fn(), error: vi.fn() },
  });

  await handler(req, res);
  return { res, store };
}

describe("quote event webhook", () => {
  it("verifies prototype-compatible HMAC signatures", () => {
    const body = eventBody();

    expect(
      verifyQuoteEventWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body),
        secret: SECRET,
        now: NOW,
        replayWindowMs: 300_000,
      }),
    ).toEqual({ ok: true });

    expect(
      verifyQuoteEventWebhookSignature({
        rawBody: `${body} `,
        signatureHeader: sign(body),
        secret: SECRET,
        now: NOW,
        replayWindowMs: 300_000,
      }),
    ).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects stale signatures", () => {
    const body = eventBody();

    expect(
      verifyQuoteEventWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body, NOW - 301_000),
        secret: SECRET,
        now: NOW,
        replayWindowMs: 300_000,
      }),
    ).toEqual({ ok: false, reason: "stale signature" });
  });

  it("persists a signed event and acknowledges duplicates", async () => {
    const body = eventBody();
    const store = createStore();

    const first = await invoke({ body, signature: sign(body), store });
    const second = await invoke({ body, signature: sign(body), store });

    expect(first.res.statusCode).toBe(202);
    expect(JSON.parse(String(first.res.body))).toMatchObject({
      ok: true,
      duplicate: false,
      eventId: "evt_123",
    });
    expect(second.res.statusCode).toBe(202);
    expect(JSON.parse(String(second.res.body))).toMatchObject({
      ok: true,
      duplicate: true,
      eventId: "evt_123",
    });
    expect(store.calls).toHaveLength(2);
  });

  it("schedules the originating agent session for terminal events", async () => {
    const body = eventBody();
    const store = createStore();
    const scheduleSessionTurn = vi.fn(async () => ({ id: "cron-1" }));

    const { res } = await invoke({
      body,
      signature: sign(body),
      store,
      sessionWorkflow: { scheduleSessionTurn },
    });

    expect(res.statusCode).toBe(202);
    expect(scheduleSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:whatsapp:526121347942",
        delayMs: 1,
        deliveryMode: "announce",
        agentId: "main",
      }),
    );
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain(
      "El recibo ya termino de procesarse.",
    );
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain(
      "Cotizacion: SOL20260629-test",
    );
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain(
      "PDF: https://solayre.lovable.app/quotes/SOL20260629-test.pdf",
    );
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain("Juan Perez");
    expect(store.jobs[0]?.webhook_resumed_at).toBe(NOW);
  });

  it("resumes a real SQLite pending quote job from a signed terminal event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-webhook-sqlite-"));
    const db = new SqliteDatabase({ dbPath: path.join(dir, "lead-bot.db") });
    db.migrate();
    try {
      await db.createPendingQuoteJob({
        requestId: "req_123",
        customerPhone: "526121347942",
        mediaPath: "/tmp/receipt.pdf",
        agentSessionKey: "agent:main:whatsapp:526121347942",
        agentSessionId: "session-123",
        invokingAgentId: "main",
        nextPollAt: NOW,
      });
      const scheduleSessionTurn = vi.fn(async () => ({ id: "cron-1" }));
      const body = eventBody("evt_sqlite_123");

      const { res } = await invoke({
        body,
        signature: sign(body),
        store: db,
        sessionWorkflow: { scheduleSessionTurn },
      });

      expect(res.statusCode).toBe(202);
      expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
      const job = await db.getPendingQuoteJobByRequestId("req_123");
      expect(job?.webhook_resumed_at).toBe(NOW);

      const duplicate = await invoke({
        body,
        signature: sign(body),
        store: db,
        sessionWorkflow: { scheduleSessionTurn },
      });
      expect(duplicate.res.statusCode).toBe(202);
      expect(JSON.parse(String(duplicate.res.body))).toMatchObject({
        ok: true,
        duplicate: true,
      });
      expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resume the agent twice for duplicate terminal events", async () => {
    const body = eventBody();
    const store = createStore();
    const scheduleSessionTurn = vi.fn(async () => ({ id: "cron-1" }));
    const sessionWorkflow = { scheduleSessionTurn };

    await invoke({ body, signature: sign(body), store, sessionWorkflow });
    await invoke({ body, signature: sign(body), store, sessionWorkflow });

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
  });

  it("accepts failed terminal events with error details", async () => {
    const body = failedEventBody();
    const store = createStore();
    const scheduleSessionTurn = vi.fn(async () => ({ id: "cron-1" }));

    const { res } = await invoke({
      body,
      signature: sign(body),
      store,
      sessionWorkflow: { scheduleSessionTurn },
    });

    expect(res.statusCode).toBe(202);
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain(
      "El procesamiento del recibo fallo.",
    );
    expect(String(scheduleSessionTurn.mock.calls[0]?.[0]?.message)).toContain(
      "Error: No se pudo leer el recibo CFE.",
    );
    expect(store.jobs[0]?.webhook_resumed_at).toBe(NOW);
  });

  it("rejects completed events without quote delivery fields", async () => {
    const body = JSON.stringify({
      event_id: "evt_missing_delivery_fields",
      type: "calculation.completed",
      source: "solayre.parse-and-quote",
      payload: {
        request_id: "req_123",
        quote_id: "quote_123",
      },
    });
    const store = createStore();
    const scheduleSessionTurn = vi.fn(async () => ({ id: "cron-1" }));

    const { res } = await invoke({
      body,
      signature: sign(body),
      store,
      sessionWorkflow: { scheduleSessionTurn },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(String(res.body))).toEqual({
      ok: false,
      error: "invalid event envelope",
    });
    expect(store.calls).toHaveLength(0);
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON after signature validation", async () => {
    const body = "{";
    const { res } = await invoke({ body, signature: sign(body) });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(String(res.body))).toEqual({
      ok: false,
      error: "invalid event envelope",
    });
  });

  it("rejects bad signatures before storing", async () => {
    const body = eventBody();
    const store = createStore();
    const { res } = await invoke({ body, signature: sign(`${body} `), store });

    expect(res.statusCode).toBe(401);
    expect(store.calls).toHaveLength(0);
  });
});
