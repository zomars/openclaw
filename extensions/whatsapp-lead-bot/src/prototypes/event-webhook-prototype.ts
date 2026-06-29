/**
 * PROTOTYPE - delete or absorb after the event-webhook shape is validated.
 *
 * Run:
 *   node --import tsx extensions/whatsapp-lead-bot/src/prototypes/event-webhook-prototype.ts
 */

import { createHmac, timingSafeEqual } from "node:crypto";

type EventType =
  | "calculation.started"
  | "calculation.progress"
  | "calculation.completed"
  | "calculation.failed";

interface EventEnvelope {
  event_id: string;
  type: EventType;
  source: "solayre.parse-and-quote" | "solayre.cfe-api";
  subject: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface StoredEvent {
  eventId: string;
  type: EventType | "unknown";
  source: string;
  subject: string;
  status: "accepted" | "duplicate" | "dispatched" | "rejected";
  reason?: string;
  duplicateCount?: number;
}

interface QuoteJob {
  requestId: string;
  customerPhone: string;
  status: "pending" | "delivered" | "failed";
  quoteNumber?: string;
  lastError?: string;
  deliveredMessages: number;
}

interface IntakeResult {
  status: number;
  body: string;
}

const SECRET = "prototype-secret-rotate-me";
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const EVENT_TYPES = new Set<EventType>([
  "calculation.started",
  "calculation.progress",
  "calculation.completed",
  "calculation.failed",
]);

class EventWebhookPrototype {
  private readonly events = new Map<string, StoredEvent>();
  private readonly quoteJobs = new Map<string, QuoteJob>();
  private readonly dispatchQueue: EventEnvelope[] = [];

  createCalculationRequest(input: { requestId: string; customerPhone: string }): void {
    this.quoteJobs.set(input.requestId, {
      requestId: input.requestId,
      customerPhone: input.customerPhone,
      status: "pending",
      deliveredMessages: 0,
    });
    this.printState(`created calculation_request ${input.requestId}`);
  }

  receive(rawBody: string, headers: Record<string, string>): IntakeResult {
    const verified = verifySignature(rawBody, headers["x-openclaw-signature"], Date.now());
    if (!verified.ok) {
      this.recordRejected(rawBody, verified.reason);
      return { status: 401, body: verified.reason };
    }

    const parsed = parseEnvelope(rawBody);
    if (!parsed.ok) {
      this.recordRejected(rawBody, parsed.reason);
      return { status: 400, body: parsed.reason };
    }

    const event = parsed.event;
    if (this.events.has(event.event_id)) {
      const existing = this.events.get(event.event_id);
      if (existing) {
        this.events.set(event.event_id, {
          ...existing,
          duplicateCount: (existing.duplicateCount ?? 0) + 1,
        });
      }
      return { status: 202, body: "duplicate" };
    }

    this.events.set(event.event_id, {
      eventId: event.event_id,
      type: event.type,
      source: event.source,
      subject: event.subject,
      status: "accepted",
    });
    this.dispatchQueue.push(event);
    return { status: 202, body: "accepted" };
  }

  drainDispatchQueue(): void {
    while (this.dispatchQueue.length > 0) {
      const event = this.dispatchQueue.shift();
      if (!event) {
        break;
      }
      this.dispatch(event);
    }
    this.printState("drained dispatch queue");
  }

  printState(label: string): void {
    const state = {
      label,
      event_store: [...this.events.values()],
      dispatch_queue: this.dispatchQueue.map((event) => ({
        eventId: event.event_id,
        type: event.type,
        subject: event.subject,
      })),
      quote_jobs: [...this.quoteJobs.values()],
    };
    console.log(JSON.stringify(state, null, 2));
  }

  private dispatch(event: EventEnvelope): void {
    const requestId = String(event.payload.request_id ?? "");
    const job = this.quoteJobs.get(requestId);

    if (!job) {
      this.events.set(event.event_id, {
        eventId: event.event_id,
        type: event.type,
        source: event.source,
        subject: event.subject,
        status: "rejected",
        reason: `unknown request_id ${requestId}`,
      });
      return;
    }

    if (event.type === "calculation.completed") {
      job.status = "delivered";
      job.quoteNumber = String(event.payload.quote_number ?? "");
      job.lastError = undefined;
      job.deliveredMessages += 1;
      this.events.set(event.event_id, {
        eventId: event.event_id,
        type: event.type,
        source: event.source,
        subject: event.subject,
        status: "dispatched",
      });
      return;
    }

    if (event.type === "calculation.failed") {
      job.status = "failed";
      job.lastError = String(event.payload.error ?? "calculation failed");
      this.events.set(event.event_id, {
        eventId: event.event_id,
        type: event.type,
        source: event.source,
        subject: event.subject,
        status: "dispatched",
      });
      return;
    }

    this.events.set(event.event_id, {
      eventId: event.event_id,
      type: event.type,
      source: event.source,
      subject: event.subject,
      status: "dispatched",
      reason: "progress event recorded only",
    });
  }

  private recordRejected(rawBody: string, reason: string): void {
    const eventId = readEventId(rawBody) ?? `rejected:${this.events.size + 1}`;
    this.events.set(eventId, {
      eventId,
      type: "unknown",
      source: "unknown",
      subject: "unknown",
      status: "rejected",
      reason,
    });
  }
}

function parseEnvelope(
  rawBody: string,
): { ok: true; event: EventEnvelope } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, reason: "event must be an object" };
  }
  const value = json as Record<string, unknown>;
  const eventId = stringField(value, "event_id");
  const type = stringField(value, "type");
  const source = stringField(value, "source");
  const subject = stringField(value, "subject");
  const occurredAt = stringField(value, "occurred_at");
  const payload = value.payload;

  if (!eventId || !type || !source || !subject || !occurredAt) {
    return { ok: false, reason: "missing required envelope field" };
  }
  if (!EVENT_TYPES.has(type as EventType)) {
    return { ok: false, reason: `unsupported event type ${type}` };
  }
  if (source !== "solayre.parse-and-quote" && source !== "solayre.cfe-api") {
    return { ok: false, reason: `unsupported source ${source}` };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  return {
    ok: true,
    event: {
      event_id: eventId,
      type: type as EventType,
      source,
      subject,
      occurred_at: occurredAt,
      payload: payload as Record<string, unknown>,
    },
  };
}

function signBody(rawBody: string, timestamp: number): string {
  const digest = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function verifySignature(
  rawBody: string,
  header: string | undefined,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!header) {
    return { ok: false, reason: "missing signature" };
  }
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) {
    return { ok: false, reason: "malformed signature" };
  }
  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: "stale signature" };
  }

  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return { ok: false, reason: "signature mismatch" };
  }
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

function signedHeaders(rawBody: string, timestamp = Date.now()): Record<string, string> {
  return { "x-openclaw-signature": signBody(rawBody, timestamp) };
}

function event(input: Partial<EventEnvelope> & { event_id: string; type: EventType }): string {
  return JSON.stringify({
    source: "solayre.parse-and-quote",
    subject: "quote_request:req_123",
    occurred_at: new Date().toISOString(),
    payload: { request_id: "req_123" },
    ...input,
  });
}

function readEventId(rawBody: string): string | null {
  try {
    const value = JSON.parse(rawBody) as Record<string, unknown>;
    return stringField(value, "event_id") ?? null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function printReceive(label: string, result: IntakeResult, app: EventWebhookPrototype): void {
  console.log(`\n# ${label}`);
  console.log(JSON.stringify(result, null, 2));
  app.printState(label);
}

async function main(): Promise<void> {
  const app = new EventWebhookPrototype();
  app.createCalculationRequest({ requestId: "req_123", customerPhone: "+5216670000000" });

  const unsigned = event({
    event_id: "evt_unsigned",
    type: "calculation.completed",
    payload: { request_id: "req_123", quote_number: "SOL-PROTO-001" },
  });
  printReceive("rejects unsigned event", app.receive(unsigned, {}), app);

  const completed = event({
    event_id: "evt_completed",
    type: "calculation.completed",
    payload: {
      request_id: "req_123",
      quote_id: "quote_123",
      quote_number: "SOL-PROTO-001",
      pdf_url: "https://example.invalid/quote.pdf",
    },
  });
  printReceive(
    "accepts signed completed event",
    app.receive(completed, signedHeaders(completed)),
    app,
  );
  app.drainDispatchQueue();

  printReceive("dedupes retry by event_id", app.receive(completed, signedHeaders(completed)), app);
  app.drainDispatchQueue();

  const orphan = event({
    event_id: "evt_orphan",
    type: "calculation.failed",
    subject: "quote_request:req_missing",
    payload: { request_id: "req_missing", error: "upstream timeout" },
  });
  printReceive("dead-letters unknown request", app.receive(orphan, signedHeaders(orphan)), app);
  app.drainDispatchQueue();

  const stale = event({
    event_id: "evt_stale",
    type: "calculation.failed",
    payload: { request_id: "req_123", error: "late failure should not replay" },
  });
  printReceive(
    "rejects stale signed event",
    app.receive(stale, signedHeaders(stale, Date.now() - SIGNATURE_WINDOW_MS - 1_000)),
    app,
  );

  console.log(
    "\nPrototype answer: signed event ingest can replace long-poll completion checks, but dispatch should stay async and polling should remain as fallback for missing events.",
  );
}

await main();
