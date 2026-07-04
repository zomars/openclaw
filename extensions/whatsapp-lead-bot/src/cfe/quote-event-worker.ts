import type {
  HandoffLog,
  LeadRepository,
  PendingQuoteJobStore,
  QuoteWebhookEventStore,
} from "../database.js";
import type { Lead, QuoteWebhookEventRow } from "../database/schema.js";
import type { Runtime } from "../runtime.js";
import { normalizePhone } from "../utils/phone.js";

export interface QuoteEventWorkerStore
  extends QuoteWebhookEventStore, PendingQuoteJobStore, LeadRepository, HandoffLog {}

export interface QuoteEventWorkerDeps {
  store: QuoteEventWorkerStore;
  runtime?: Runtime | null;
  agentPhones?: string[];
  now?: () => number;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}

export interface QuoteEventWorkerOptions {
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  batchSize?: number;
}

type QuoteLifecycleEventType =
  | "quote.opened"
  | "quote.pdf_exported"
  | "payment.started"
  | "payment.paid"
  | "payment.failed";

type StoredQuoteEventEnvelope = {
  event_id: string;
  type: string;
  source: string;
  occurred_at?: string;
  subject?: string;
  payload?: Record<string, unknown>;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 10;

const HANDOFF_EVENT_BY_TYPE: Record<QuoteLifecycleEventType, string> = {
  "quote.opened": "quote_opened",
  "quote.pdf_exported": "quote_pdf_exported",
  "payment.started": "quote_payment_started",
  "payment.paid": "quote_payment_paid",
  "payment.failed": "quote_payment_failed",
};

export class QuoteEventWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: QuoteEventWorkerDeps,
    options: QuoteEventWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const rows = await this.deps.store.getDueQuoteWebhookEvents(this.now(), this.batchSize);
      for (const row of rows) {
        await this.processRow(row);
      }
    } catch (err) {
      this.deps.log?.error?.(`[quote-event-worker] poll failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async processRow(row: QuoteWebhookEventRow): Promise<void> {
    const claimed = await this.deps.store.markQuoteWebhookEventDispatching(row.id, this.now());
    if (!claimed) {
      return;
    }

    const attempts = row.attempts + 1;
    try {
      await this.dispatchRow(row);
      await this.deps.store.markQuoteWebhookEventProcessed(row.id, this.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= this.maxAttempts) {
        await this.deps.store.deadLetterQuoteWebhookEvent(row.id, {
          error: message,
          processedAt: this.now(),
        });
        return;
      }
      await this.deps.store.rescheduleQuoteWebhookEvent(row.id, {
        attempts,
        nextAttemptAt: this.now() + this.retryDelayMs * attempts,
        lastError: message,
      });
    }
  }

  private async dispatchRow(row: QuoteWebhookEventRow): Promise<void> {
    if (!isQuoteLifecycleEvent(row.event_type)) {
      return;
    }

    const envelope = parseEnvelope(row);
    const lead = await this.resolveLead(row, envelope);
    if (!lead) {
      throw new Error(`lead not found for quote event ${row.source}:${row.event_id}`);
    }

    const metadata = buildMetadata(row, envelope);
    await this.deps.store.logHandoffEvent(
      lead.id,
      HANDOFF_EVENT_BY_TYPE[row.event_type],
      "lovable",
      metadata,
    );
    await this.deps.store.updateCustomFields(lead.id, buildCustomFields(row.event_type, metadata));

    if (row.event_type === "payment.paid" || row.event_type === "payment.failed") {
      await this.notifyAgents(row.event_type, lead, metadata);
    }
  }

  private async resolveLead(
    row: QuoteWebhookEventRow,
    envelope: StoredQuoteEventEnvelope,
  ): Promise<Lead | null> {
    const payload = envelope.payload ?? {};
    const phones = phoneLookupCandidates(stringField(payload.customer_phone));
    for (const phone of phones) {
      const lead = await this.deps.store.getLeadByPhone(phone);
      if (lead) {
        return lead;
      }
    }

    const requestId = stringField(payload.request_id) ?? row.request_id;
    if (!requestId) {
      return null;
    }
    const job = await this.deps.store.getPendingQuoteJobByRequestId(requestId);
    return job ? await this.deps.store.getLeadByPhone(job.customer_phone) : null;
  }

  private async notifyAgents(
    eventType: QuoteLifecycleEventType,
    lead: Lead,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.runtime || !this.deps.agentPhones?.length) {
      return;
    }
    const quoteNumber = stringField(metadata.quoteNumber) ?? "sin folio";
    const text =
      eventType === "payment.paid"
        ? `Pago de anticipo confirmado para ${lead.phone_number}. Cotizacion: ${quoteNumber}.`
        : `Pago de anticipo fallido para ${lead.phone_number}. Cotizacion: ${quoteNumber}.`;
    for (const phone of this.deps.agentPhones) {
      try {
        await this.deps.runtime.sendMessage(phone, {
          text,
          metadata: {
            openclawInitiated: true,
            source: "quote-event-worker",
            eventType,
            quoteNumber,
          },
        });
      } catch (err) {
        this.deps.log?.warn?.(`[quote-event-worker] notify ${phone} failed: ${String(err)}`);
      }
    }
  }
}

function isQuoteLifecycleEvent(eventType: string): eventType is QuoteLifecycleEventType {
  return (
    eventType === "quote.opened" ||
    eventType === "quote.pdf_exported" ||
    eventType === "payment.started" ||
    eventType === "payment.paid" ||
    eventType === "payment.failed"
  );
}

function parseEnvelope(row: QuoteWebhookEventRow): StoredQuoteEventEnvelope {
  const parsed = JSON.parse(row.payload_json) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid quote event payload for ${row.source}:${row.event_id}`);
  }
  return parsed as StoredQuoteEventEnvelope;
}

function buildMetadata(
  row: QuoteWebhookEventRow,
  envelope: StoredQuoteEventEnvelope,
): Record<string, unknown> {
  const payload = envelope.payload ?? {};
  return {
    source: row.source,
    eventId: row.event_id,
    eventType: row.event_type,
    subject: row.subject,
    occurredAt: envelope.occurred_at ?? null,
    requestId: stringField(payload.request_id) ?? row.request_id,
    customerPhone: stringField(payload.customer_phone),
    quoteAccessTokenId: stringField(payload.quote_access_token_id),
    quoteId: stringField(payload.quote_id),
    quoteNumber: stringField(payload.quote_number),
    quoteVersionId: stringField(payload.quote_version_id),
    paymentId: stringField(payload.payment_id),
    stripeCheckoutSessionId: stringField(payload.stripe_checkout_session_id),
    amount: numberField(payload.amount),
    currency: stringField(payload.currency),
    failureReason: stringField(payload.failure_reason),
  };
}

function buildCustomFields(
  eventType: QuoteLifecycleEventType,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    last_quote_event_type: eventType,
    last_quote_event_at: metadata.occurredAt ?? Date.now(),
    last_quote_event_id: metadata.eventId,
    last_quote_number: metadata.quoteNumber,
    last_quote_version_id: metadata.quoteVersionId,
    quote_payment_status:
      eventType === "payment.paid"
        ? "paid"
        : eventType === "payment.failed"
          ? "failed"
          : eventType === "payment.started"
            ? "started"
            : undefined,
  };
}

function phoneLookupCandidates(phone: string | undefined): string[] {
  if (!phone) {
    return [];
  }
  const digits = normalizePhone(phone);
  if (!digits) {
    return [];
  }
  const candidates = [digits, `+${digits}`];
  if (digits.startsWith("52") && digits.length === 12) {
    candidates.push(`521${digits.slice(2)}`, `+521${digits.slice(2)}`);
  }
  if (digits.startsWith("521") && digits.length === 13) {
    candidates.push(`52${digits.slice(3)}`, `+52${digits.slice(3)}`);
  }
  return [...new Set(candidates)];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
