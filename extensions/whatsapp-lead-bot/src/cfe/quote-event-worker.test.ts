import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../database/connection.js";
import type { HandoffLog, Lead } from "../database/schema.js";
import { QuoteEventWorker } from "./quote-event-worker.js";

const NOW = 1_800_000;

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-event-worker-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "lead-bot.db") });
  db.migrate();
  return { db, dir };
}

function sqlFor(db: SqliteDatabase) {
  return (
    db as unknown as {
      db: {
        prepare: (q: string) => {
          all: (...args: unknown[]) => unknown[];
          get: (...args: unknown[]) => unknown;
        };
      };
    }
  ).db;
}

function paymentPaidEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_payment_paid",
    type: "payment.paid",
    source: "solayre.parse-and-quote",
    subject: "quote_version:qv_123",
    occurred_at: "2026-07-03T18:25:00Z",
    payload: {
      request_id: "req_123",
      customer_phone: "526121347942",
      quote_access_token_id: "qat_123",
      quote_id: "quote_123",
      quote_number: "SOL20260703-test",
      quote_version_id: "qv_123",
      payment_id: "pay_123",
      stripe_checkout_session_id: "cs_test_123",
      amount: 5000,
      currency: "MXN",
      ...overrides,
    },
  };
}

describe("QuoteEventWorker", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps exact-version payment events to the lead audit trail and custom fields", async () => {
    const { db, dir } = createDb();
    cleanup.push(dir);
    const lead = await db.upsertLead("526121347942", { name: "Cliente" });
    await db.createPendingQuoteJob({
      requestId: "req_123",
      customerPhone: "526121347942",
      mediaPath: "/tmp/receipt.pdf",
      nextPollAt: NOW,
    });
    const envelope = paymentPaidEnvelope();
    await db.recordQuoteWebhookEvent({
      source: envelope.source,
      eventId: envelope.event_id,
      eventType: envelope.type,
      requestId: envelope.payload.request_id,
      subject: envelope.subject,
      payload: envelope,
      receivedAt: NOW,
    });

    const worker = new QuoteEventWorker({ store: db, now: () => NOW });
    await worker.pollOnce();

    const events = sqlFor(db)
      .prepare("SELECT * FROM handoff_log WHERE lead_id = ?")
      .all(lead.id) as HandoffLog[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "quote_payment_paid",
      triggered_by: "lovable",
    });
    expect(JSON.parse(String(events[0]?.metadata))).toMatchObject({
      eventType: "payment.paid",
      quoteNumber: "SOL20260703-test",
      quoteVersionId: "qv_123",
      paymentId: "pay_123",
      amount: 5000,
      currency: "MXN",
    });

    const updated = (await db.getLeadById(lead.id)) as Lead;
    expect(JSON.parse(updated.custom_fields)).toMatchObject({
      last_quote_event_type: "payment.paid",
      last_quote_event_id: "evt_payment_paid",
      last_quote_number: "SOL20260703-test",
      last_quote_version_id: "qv_123",
      quote_payment_status: "paid",
    });

    const row = sqlFor(db)
      .prepare("SELECT status, processed_at FROM quote_webhook_events WHERE event_id = ?")
      .get("evt_payment_paid") as { status: string; processed_at: number | null };
    expect(row).toEqual({ status: "processed", processed_at: NOW });
  });

  it("dead-letters lifecycle events that cannot be mapped to a lead", async () => {
    const { db, dir } = createDb();
    cleanup.push(dir);
    const envelope = paymentPaidEnvelope({
      request_id: undefined,
      customer_phone: undefined,
    });
    await db.recordQuoteWebhookEvent({
      source: envelope.source,
      eventId: envelope.event_id,
      eventType: envelope.type,
      requestId: null,
      subject: envelope.subject,
      payload: envelope,
      receivedAt: NOW,
    });

    const worker = new QuoteEventWorker(
      {
        store: db,
        now: () => NOW,
      },
      {
        maxAttempts: 1,
      },
    );
    await worker.pollOnce();

    const row = sqlFor(db)
      .prepare("SELECT status, last_error FROM quote_webhook_events WHERE event_id = ?")
      .get("evt_payment_paid") as { status: string; last_error: string | null };
    expect(row.status).toBe("dead_lettered");
    expect(row.last_error).toContain("lead not found");
  });
});
