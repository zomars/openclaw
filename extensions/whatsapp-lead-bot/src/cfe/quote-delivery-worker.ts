import { appendResolvedLeadEvent, type LeadEventLog } from "../crm-memory/lead-events.js";
import { resolveCrmMemoryRolloutFlags, type CrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { PendingQuoteJobStore } from "../database.js";
import type { PendingQuoteJob } from "../database/schema.js";
import {
  deliverLeadCFEQuote,
  type DeliverLeadCFEQuoteDeps,
} from "../tools/process-lead-cfe-receipt.js";
import { normalizePhone } from "../utils/phone.js";
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  QuoteRequestCheckResult,
} from "./parse-and-quote-client.js";
import type { QuoteAccessTokenClient, QuoteAccessTokenResult } from "./quote-access-client.js";

export interface QuoteDeliveryWorkerDeps extends DeliverLeadCFEQuoteDeps {
  store: PendingQuoteJobStore;
  eventLog?: LeadEventLog;
  config?: { crmMemory?: Partial<CrmMemoryRolloutFlags> };
  checkRequest: ParseAndQuoteClient["checkRequest"];
  quoteAccess?: QuoteAccessTokenClient | null;
  agentPhones: string[];
}

export interface QuoteDeliveryWorkerOptions {
  pollIntervalMs?: number;
  requestWaitMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_WAIT_MS = 25_000;
const DEFAULT_MAX_ATTEMPTS = 120;
const DEFAULT_BATCH_SIZE = 5;

export class QuoteDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly requestWaitMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: QuoteDeliveryWorkerDeps,
    options: QuoteDeliveryWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestWaitMs = options.requestWaitMs ?? DEFAULT_REQUEST_WAIT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = options.now ?? Date.now;
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
      const jobs = await this.deps.store.getDuePendingQuoteJobs(this.now(), this.batchSize);
      for (const job of jobs) {
        const claimed = await this.deps.store.markPendingQuoteJobDelivering(job.id, this.now());
        if (!claimed) {
          continue;
        }
        await this.processJob({ ...job, status: "delivering", updated_at: this.now() });
      }
    } catch (err) {
      console.error("[quote-delivery-worker] poll failed:", err);
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: PendingQuoteJob): Promise<void> {
    const attempts = job.attempts + 1;
    let checked: QuoteRequestCheckResult | ParseAndQuoteError;

    try {
      checked = await this.deps.checkRequest(job.request_id, { waitMs: this.requestWaitMs });
    } catch (err) {
      checked = { success: false, error: `checkRequest threw: ${String(err)}` };
    }

    if (!checked.success) {
      await this.failOrRetry(job, attempts, checked.error);
      return;
    }

    if (checked.status !== "done") {
      await this.reschedule(job, attempts, checked.status);
      return;
    }

    const delivered = await deliverLeadCFEQuote({
      customerPhone: job.customer_phone,
      result: checked.result,
      deps: this.deps,
    });

    if (!delivered.success) {
      await this.deps.store.markPendingQuoteJobFailed(job.id, {
        attempts,
        error: delivered.error ?? "delivery failed",
        quoteId: checked.result.quoteId,
        quoteNumber: checked.result.quoteNumber,
      });
      this.appendQuoteCrmEvent(job, {
        type: "quote.failed",
        attempts,
        quoteId: checked.result.quoteId,
        quoteNumber: checked.result.quoteNumber,
        error: delivered.error ?? "delivery failed",
      });
      await this.notifyAgents(
        `Aviso: fallo la entrega de la cotizacion ${checked.result.quoteNumber} para ${job.customer_phone}: ${delivered.error ?? "delivery failed"}.`,
      );
      return;
    }

    const quoteAccess = await this.createQuoteAccess(checked.result.quoteNumber);
    if (quoteAccess) {
      await this.sendQuoteAccessLink(job, checked.result.quoteNumber, quoteAccess);
    }

    await this.deps.store.markPendingQuoteJobDelivered(job.id, {
      attempts,
      quoteId: checked.result.quoteId,
      quoteNumber: checked.result.quoteNumber,
      quoteAccess,
    });
    this.appendQuoteCrmEvent(job, {
      type: "quote.delivered",
      attempts,
      quoteId: checked.result.quoteId,
      quoteNumber: checked.result.quoteNumber,
      quoteAccessUrl: quoteAccess?.url ?? null,
      quoteAccessTokenId: quoteAccess?.tokenId ?? null,
      quoteAccessExpiresAt: quoteAccess?.expiresAt ?? null,
    });
  }

  private async createQuoteAccess(quoteNumber: string): Promise<QuoteAccessTokenResult | null> {
    if (!this.deps.quoteAccess) {
      return null;
    }

    try {
      return await this.deps.quoteAccess.getOrCreateQuoteToken({ quoteNumber });
    } catch (err) {
      console.error(`[quote-delivery-worker] quote URL creation failed for ${quoteNumber}:`, err);
      return null;
    }
  }

  private async sendQuoteAccessLink(
    job: PendingQuoteJob,
    quoteNumber: string,
    quoteAccess: QuoteAccessTokenResult,
  ): Promise<void> {
    try {
      await this.deps.runtime.sendMessage(job.customer_phone, {
        text: quoteAccessMessage(quoteAccess.url, quoteAccess.expiresAt),
        metadata: {
          openclawInitiated: true,
          source: "quote-delivery-worker:quote-url",
          requestId: job.request_id,
          quoteNumber,
          quoteAccessTokenId: quoteAccess.tokenId,
          quoteAccessUrl: quoteAccess.url,
          quoteAccessExpiresAt: quoteAccess.expiresAt,
        },
      });
    } catch (err) {
      console.error(
        `[quote-delivery-worker] quote URL send failed for ${quoteNumber}; PDF delivery remains complete:`,
        err,
      );
    }
  }

  private async reschedule(job: PendingQuoteJob, attempts: number, status: string): Promise<void> {
    if (attempts >= this.maxAttempts) {
      const error = `max attempts reached while status=${status}`;
      await this.deps.store.markPendingQuoteJobFailed(job.id, {
        attempts,
        error,
      });
      this.appendQuoteCrmEvent(job, {
        type: "quote.failed",
        attempts,
        error,
      });
      await this.notifyAgents(
        `Aviso: la cotizacion para ${job.customer_phone} no termino despues de ${attempts} intentos. Request: ${job.request_id}.`,
      );
      return;
    }

    await this.deps.store.reschedulePendingQuoteJob(job.id, {
      attempts,
      nextPollAt: this.now() + this.pollIntervalMs,
      lastError: status,
    });
  }

  private async failOrRetry(job: PendingQuoteJob, attempts: number, error: string): Promise<void> {
    if (attempts >= this.maxAttempts || isTerminalError(error)) {
      await this.deps.store.markPendingQuoteJobFailed(job.id, { attempts, error });
      this.appendQuoteCrmEvent(job, {
        type: "quote.failed",
        attempts,
        error,
      });
      if (isIncompleteReceiptError(error)) {
        await this.sendIncompleteReceiptMessage(job);
      } else {
        await this.notifyAgents(
          `Aviso: fallo el procesamiento del recibo CFE para ${job.customer_phone}. Request: ${job.request_id}. Error: ${error}.`,
        );
      }
      return;
    }

    await this.deps.store.reschedulePendingQuoteJob(job.id, {
      attempts,
      nextPollAt: this.now() + this.pollIntervalMs,
      lastError: error,
    });
  }

  private async sendIncompleteReceiptMessage(job: PendingQuoteJob): Promise<void> {
    try {
      await this.deps.runtime.sendMessage(job.customer_phone, {
        text: MSG_INCOMPLETE_RECEIPT,
        metadata: {
          openclawInitiated: true,
          source: "quote-delivery-worker:incomplete_receipt",
          requestId: job.request_id,
        },
      });
    } catch (err) {
      console.error("[quote-delivery-worker] sendIncompleteReceiptMessage failed:", err);
    }
  }

  private async notifyAgents(text: string): Promise<void> {
    for (const phone of this.deps.agentPhones) {
      try {
        await this.deps.runtime.sendMessage(phone, {
          text,
          metadata: { openclawInitiated: true, source: "quote-delivery-worker" },
        });
      } catch (err) {
        console.error(`[quote-delivery-worker] notify ${phone} failed:`, err);
      }
    }
  }

  private appendQuoteCrmEvent(
    job: PendingQuoteJob,
    input: {
      type: "quote.delivered" | "quote.failed";
      attempts: number;
      quoteId?: string | null;
      quoteNumber?: string | null;
      quoteAccessTokenId?: string | null;
      quoteAccessUrl?: string | null;
      quoteAccessExpiresAt?: number | null;
      error?: string | null;
    },
  ): void {
    const flags = resolveCrmMemoryRolloutFlags(this.deps.config?.crmMemory);
    if (!flags.eventWritesEnabled || !this.deps.eventLog) {
      return;
    }

    const leadPhone = normalizePhone(job.customer_phone);
    if (!leadPhone) {
      return;
    }

    try {
      appendResolvedLeadEvent({
        scope: {
          leadKey: `whatsapp:${leadPhone}`,
          leadPhone,
        },
        log: this.deps.eventLog,
        now: this.now,
        event: {
          type: input.type,
          actor: "system",
          source: {
            channel: "system",
            toolName: "quote-delivery-worker",
          },
          summary:
            input.type === "quote.delivered"
              ? "Quote delivered to lead."
              : "Quote delivery failed.",
          payload: {
            requestId: job.request_id,
            jobId: job.id,
            attempts: input.attempts,
            quoteId: input.quoteId ?? null,
            quoteNumber: input.quoteNumber ?? null,
            quoteAccessTokenId: input.quoteAccessTokenId ?? null,
            quoteAccessUrl: input.quoteAccessUrl ?? null,
            quoteAccessExpiresAt: input.quoteAccessExpiresAt ?? null,
            error: input.error ?? null,
          },
        },
      });
    } catch (err) {
      console.error("[quote-delivery-worker] Failed to append CRM memory event:", err);
    }
  }
}

const MSG_INCOMPLETE_RECEIPT = [
  "Gracias por enviar su recibo, pero la foto solo muestra una parte.",
  "Necesito ver la parte de arriba del recibo donde aparecen:",
  "\u2022 Su nombre completo",
  "\u2022 El RPU (n\u00famero de registro)",
  "\u2022 La tarifa (1, 1A, DAC, etc.)",
  "\u2022 El n\u00famero de servicio",
  "",
  "\u00bfPodr\u00eda tomar una foto donde se vea COMPLETO el recibo? \ud83d\ude4f",
].join("\n");

function isIncompleteReceiptError(error: string): boolean {
  return (
    error.includes("incomplete_receipt") ||
    error.includes("tariffType") ||
    error.includes("Cannot read properties of undefined")
  );
}

function isTerminalError(error: string): boolean {
  return (
    error.includes("not found") ||
    error.includes("response missing") ||
    error.includes("parse-and-quote failed") ||
    error.includes("incomplete_receipt") ||
    error.includes("tariffType") ||
    error.includes("Cannot read properties of undefined")
  );
}

function quoteAccessMessage(url: string, expiresAt: number): string {
  return [
    "Aquí tiene el enlace de su cotización personalizada:",
    url,
    "",
    `Puede abrirla desde su celular y compartirla. Expira el ${formatDate(expiresAt)}.`,
  ].join("\n");
}

function formatDate(timestampMs: number): string {
  const formatted = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mazatlan",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestampMs));
  return formatted;
}
