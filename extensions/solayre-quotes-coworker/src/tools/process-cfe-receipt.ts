/**
 * Tool: solayre_quotes_coworker__process_cfe_receipt
 *
 * Coworker variant — the coworker forwards a CFE receipt. By default the quote
 * comes back to the coworker; when clientPhone is supplied, it is delivered to
 * the client instead. Stateless: no leads DB, no lead persistence, just parse →
 * render quote → deliver PDF + summary.
 *
 * Idempotency: an in-memory dedup cache with promise-lock prevents duplicate
 * WhatsApp acknowledgements and redundant parse-and-quote API calls when the
 * same (deliveryPhone, mediaPath) is submitted concurrently or within the TTL.
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
  /** Phone number (E.164 without +) of the client when direct client delivery is requested. */
  clientPhone?: string;
  /** Coworker's own phone (E.164 without +). Used for the default delivery target. */
  coworkerPhone?: string;
}

export interface ProcessCFEReceiptDeps {
  parseAndQuote: ParseAndQuoteClient["quote"];
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
  /**
   * Optional in-memory dedup cache. When provided, repeated calls for the
   * same (deliveryPhone, mediaPath) within the TTL return the cached result
   * without sending a duplicate ack or re-invoking the parse-and-quote API.
   * Defaults to a shared module-level cache when omitted.
   */
  dedupCache?: DedupCache;
}

const ERR_INTERNAL = "Tuvimos un problema generando la cotización. Intenta de nuevo en un momento.";
const ACK_PROCESSING = "Recibí el recibo, lo estoy procesando. Un momento por favor...";

/** Shared module-level dedup cache (5 min TTL). */
const defaultDedupCache = createDedupCache();

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    mediaPath: {
      type: "string" as const,
      description: "Absolute path to the CFE receipt forwarded by the coworker (image or PDF).",
    },
    clientPhone: {
      type: "string" as const,
      description:
        "Optional. Phone (E.164 without +) of the client when the coworker explicitly asks to send the quote to the client.",
    },
    coworkerPhone: {
      type: "string" as const,
      description:
        "Coworker's own phone (E.164 without +). Default delivery target when clientPhone is not provided.",
    },
  },
  required: ["mediaPath"],
};

export interface ProcessCFEReceiptResult {
  success: boolean;
  quoteId?: string;
  quoteNumber?: string;
  pdfPath?: string;
  pdfUrl?: string;
  error?: string;
}

function buildAlert(params: {
  stage: string;
  deliveryPhone: string;
  clientPhone?: string;
  coworkerPhone?: string;
  mediaPath: string;
  error: unknown;
  requestId?: string;
  code?: string;
}): string {
  const lines = [
    "🚨 Solayre coworker quote failed",
    `Stage: ${params.stage}`,
    `Delivery: ${params.deliveryPhone}`,
    ...(params.clientPhone ? [`Client: ${params.clientPhone}`] : []),
    ...(params.coworkerPhone ? [`Coworker: ${params.coworkerPhone}`] : []),
    `Media: ${path.basename(params.mediaPath)}`,
    ...(params.code ? [`Code: ${params.code}`] : []),
    ...(params.requestId ? [`Request: ${params.requestId}`] : []),
    `Error: ${params.error instanceof Error ? params.error.message : String(params.error)}`,
  ];
  return lines.join("\n");
}

async function alertFailure(
  runtime: Runtime,
  params: Parameters<typeof buildAlert>[0],
): Promise<void> {
  try {
    await runtime.sendAlert?.(buildAlert(params));
  } catch (err) {
    console.warn("[solayre-quotes-coworker] alert failed:", err);
  }
}

function buildSummary(result: ParseAndQuoteResult): string {
  const { quote, cfe } = result;
  const customer = cfe?.data?.customerName ?? "el cliente";
  const tariff = cfe?.data?.tariffType ?? "—";
  const kWh = cfe?.data?.annualConsumption ?? 0;
  const panels = quote.panelCount;
  const cash = quote.cashPrice;
  const coverage = quote.coveragePercent;
  const payback = quote.paybackYears;
  return [
    `Cotización para ${customer}`,
    `Tarifa CFE: ${tariff}`,
    `Consumo anual: ${kWh.toLocaleString("es-MX")} kWh`,
    `Sistema: ${panels} paneles`,
    `Cobertura: ${Math.round(coverage)}%`,
    `Precio de contado: $${cash.toLocaleString("es-MX")} MXN`,
    `Retorno estimado: ${payback.toFixed(1)} años`,
    `Folio: ${result.quoteNumber}`,
  ].join("\n");
}

export const processCFEReceiptCoworkerTool = {
  name: "solayre_quotes_coworker__process_cfe_receipt",
  description:
    "Process a CFE receipt forwarded by a coworker and deliver the quote PDF + summary back to " +
    "the coworker by default, or to the client only when clientPhone is provided. Stateless — " +
    "does not persist as a lead.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessCFEReceiptParams,
    deps: ProcessCFEReceiptDeps,
  ): Promise<ProcessCFEReceiptResult> => {
    const { mediaPath, clientPhone, coworkerPhone } = params;
    const { runtime, parseAndQuote, downloadFile, outputDir, dedupCache } = deps;

    const deliveryPhone = clientPhone || coworkerPhone;

    if (!mediaPath || !deliveryPhone) {
      return {
        success: false,
        error: "mediaPath and either clientPhone or coworkerPhone are required",
      };
    }

    const cache = dedupCache ?? defaultDedupCache;
    const key = dedupKey(deliveryPhone, mediaPath);

    // Use the promise-lock claim: if another invocation is already in-flight
    // for this key, we share its promise. If a completed result is cached, the
    // work function is never called — claim returns the cached result.
    return cache.claim(key, async () => {
      // Check cache again inside the claim (first caller may have raced past
      // the claim check but another caller already completed and cached).
      const cached = cache.get(key);
      if (cached) {
        console.log(`[solayre-quotes-coworker] dedup hit for ${key}, returning cached result`);
        return cached.result as ProcessCFEReceiptResult;
      }

      // Send ack — this runs exactly once per unique (phone, mediaPath) because
      // claim serializes concurrent callers.
      try {
        await runtime.sendMessage(deliveryPhone, {
          text: ACK_PROCESSING,
          metadata: { openclawInitiated: true, source: "solayre-quotes-coworker:ack" },
        });
      } catch (err) {
        console.warn("[solayre-quotes-coworker] ack failed:", err);
      }

      let parsed: ParseAndQuoteResult | ParseAndQuoteError;
      try {
        parsed = await parseAndQuote({ mediaPath, phoneNumber: deliveryPhone });
      } catch (err) {
        console.error("[solayre-quotes-coworker] parseAndQuote threw:", err);
        await alertFailure(runtime, {
          stage: "parseAndQuote:throw",
          deliveryPhone,
          clientPhone,
          coworkerPhone,
          mediaPath,
          error: err,
        });
        return { success: false, error: ERR_INTERNAL };
      }

      if (!parsed.success) {
        console.error("[solayre-quotes-coworker] parseAndQuote failed:", parsed);
        await alertFailure(runtime, {
          stage: parsed.stage ?? "parseAndQuote:error",
          deliveryPhone,
          clientPhone,
          coworkerPhone,
          mediaPath,
          error: parsed.error,
          requestId: parsed.requestId,
          code: parsed.code,
        });
        return { success: false, error: parsed.error };
      }

      const destPath = path.join(outputDir, `${parsed.quoteNumber}.pdf`);
      try {
        await downloadFile(parsed.pdfUrl, destPath);
      } catch (err) {
        console.error("[solayre-quotes-coworker] downloadFile failed:", err);
        await alertFailure(runtime, {
          stage: "downloadFile",
          deliveryPhone,
          clientPhone,
          coworkerPhone,
          mediaPath,
          error: err,
        });
        return {
          success: false,
          quoteId: parsed.quoteId,
          quoteNumber: parsed.quoteNumber,
          error: `Cotización generada (${parsed.quoteNumber}) pero falló la descarga del PDF.`,
        };
      }

      const summary = buildSummary(parsed);
      try {
        await runtime.sendMessage(deliveryPhone, {
          text: summary,
          metadata: {
            openclawInitiated: true,
            source: "solayre-quotes-coworker:quote",
            attachments: [{ path: destPath, contentType: "application/pdf" }],
          },
        });
      } catch (err) {
        console.error("[solayre-quotes-coworker] delivery failed:", err);
        await alertFailure(runtime, {
          stage: "delivery",
          deliveryPhone,
          clientPhone,
          coworkerPhone,
          mediaPath,
          error: err,
        });
        return {
          success: false,
          quoteId: parsed.quoteId,
          quoteNumber: parsed.quoteNumber,
          pdfPath: destPath,
          error: "Cotización generada pero falló la entrega.",
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
