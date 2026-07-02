/**
 * Tool: solayre_quotes_leads__process_cfe_receipt
 *
 * Leads variant — the current peer IS the lead. The operator (or the agent
 * itself) calls this when they want to generate a quote for the lead they're
 * talking to. Stateless: no leads DB writes. Lead-side persistence stays in
 * whatsapp-lead-bot via save_lead / save_receipt_data.
 *
 * Idempotency: an in-memory dedup cache with promise-lock prevents duplicate
 * WhatsApp acknowledgements and redundant parse-and-quote API calls when the
 * same (leadPhone, mediaPath) is submitted concurrently or within the TTL.
 */
import path from "node:path";
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  ParseAndQuoteResult,
} from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";
import { createDedupCache, dedupKey, type DedupCache } from "./dedup-cache.js";

export interface ProcessCFEReceiptParams {
  mediaPath: string;
  /** Lead phone number (E.164 without +). Defaults to the current peer — but the agent should pass it explicitly. */
  leadPhone: string;
}

export interface ProcessCFEReceiptDeps {
  parseAndQuote: ParseAndQuoteClient["quote"];
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
  /**
   * Optional in-memory dedup cache. When provided, repeated calls for the
   * same (leadPhone, mediaPath) within the TTL return the cached result
   * without sending a duplicate ack or re-invoking the parse-and-quote API.
   * Defaults to a shared module-level cache when omitted.
   */
  dedupCache?: DedupCache;
}

const ERR_INTERNAL = "Tuvimos un problema generando la cotización. Intenta de nuevo en un momento.";
const ACK_PROCESSING = "Recibí su recibo, lo estoy procesando. Un momento por favor...";

/** Shared module-level dedup cache (5 min TTL). */
const defaultDedupCache = createDedupCache();

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    mediaPath: {
      type: "string" as const,
      description: "Absolute path to the CFE receipt sent by the lead (image or PDF).",
    },
    leadPhone: {
      type: "string" as const,
      description: "Phone (E.164 without +) of the lead. The lead receives the quote PDF directly.",
    },
  },
  required: ["mediaPath", "leadPhone"],
};

export interface ProcessCFEReceiptResult {
  success: boolean;
  quoteId?: string;
  quoteNumber?: string;
  pdfPath?: string;
  pdfUrl?: string;
  error?: string;
}

function buildSummary(result: ParseAndQuoteResult): string {
  const { quote, cfe } = result;
  const customer = cfe?.data?.customerName ?? "el cliente";
  const tariff = cfe?.data?.tariffType ?? "—";
  const kWh = cfe?.data?.annualConsumption ?? 0;
  return [
    `Cotización para ${customer}`,
    `Tarifa CFE: ${tariff}`,
    `Consumo anual: ${kWh.toLocaleString("es-MX")} kWh`,
    `Sistema: ${quote.panelCount} paneles`,
    `Cobertura: ${Math.round(quote.coveragePercent)}%`,
    `Precio de contado: $${quote.cashPrice.toLocaleString("es-MX")} MXN`,
    `Retorno estimado: ${quote.paybackYears.toFixed(1)} años`,
    `Folio: ${result.quoteNumber}`,
  ].join("\n");
}

export const processCFEReceiptLeadsTool = {
  name: "solayre_quotes_leads__process_cfe_receipt",
  description:
    "Process a CFE receipt for a lead end-to-end via the consolidated parse-and-quote endpoint. " +
    "Sends the quote PDF + summary to the lead's phone. Stateless — the lead row is NOT updated " +
    "by this tool; chain `save_lead` / `save_receipt_data` from whatsapp-lead-bot afterward when " +
    "you want quote_id / receipt_data persisted.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessCFEReceiptParams,
    deps: ProcessCFEReceiptDeps,
  ): Promise<ProcessCFEReceiptResult> => {
    const { mediaPath, leadPhone } = params;
    const { runtime, parseAndQuote, downloadFile, outputDir, dedupCache } = deps;

    if (!mediaPath || !leadPhone) {
      return { success: false, error: "mediaPath and leadPhone are required" };
    }

    const cache = dedupCache ?? defaultDedupCache;
    const key = dedupKey(leadPhone, mediaPath);

    // Use the promise-lock claim: if another invocation is already in-flight
    // for this key, we share its promise. If a completed result is cached, the
    // work function is never called — claim returns the cached result.
    return cache.claim(key, async () => {
      // Check cache again inside the claim (first caller may have raced past
      // the claim check but another caller already completed and cached).
      const cached = cache.get(key);
      if (cached) {
        console.log(`[solayre-quotes-leads] dedup hit for ${key}, returning cached result`);
        return cached.result as ProcessCFEReceiptResult;
      }

      // Send ack — this runs exactly once per unique (leadPhone, mediaPath)
      // because claim serializes concurrent callers.
      try {
        await runtime.sendMessage(leadPhone, {
          text: ACK_PROCESSING,
          metadata: { openclawInitiated: true, source: "solayre-quotes-leads:ack" },
        });
      } catch (err) {
        console.warn("[solayre-quotes-leads] ack failed:", err);
      }

      let parsed: ParseAndQuoteResult | ParseAndQuoteError;
      try {
        parsed = await parseAndQuote({ mediaPath, phoneNumber: leadPhone });
      } catch (err) {
        console.error("[solayre-quotes-leads] parseAndQuote threw:", err);
        return { success: false, error: ERR_INTERNAL };
      }

      if (!parsed.success) {
        return { success: false, error: parsed.error };
      }

      const destPath = path.join(outputDir, `${parsed.quoteNumber}.pdf`);
      try {
        await downloadFile(parsed.pdfUrl, destPath);
      } catch (err) {
        console.error("[solayre-quotes-leads] downloadFile failed:", err);
        return {
          success: false,
          quoteId: parsed.quoteId,
          quoteNumber: parsed.quoteNumber,
          error: `Cotización generada (${parsed.quoteNumber}) pero falló la descarga del PDF.`,
        };
      }

      const summary = buildSummary(parsed);
      try {
        await runtime.sendMessage(leadPhone, {
          text: summary,
          metadata: {
            openclawInitiated: true,
            source: "solayre-quotes-leads:quote",
            attachments: [{ path: destPath, contentType: "application/pdf" }],
          },
        });
      } catch (err) {
        console.error("[solayre-quotes-leads] delivery failed:", err);
        return {
          success: false,
          quoteId: parsed.quoteId,
          quoteNumber: parsed.quoteNumber,
          pdfPath: destPath,
          error: "Cotización generada pero falló la entrega al lead.",
        };
      }

      return {
        success: true,
        quoteId: parsed.quoteId,
        quoteNumber: parsed.quoteNumber,
        pdfPath: destPath,
        pdfUrl: parsed.pdfUrl,
      };
    }) as Promise<ProcessCFEReceiptResult>;
  },
};
