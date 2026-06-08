/**
 * Tool: solayre_quotes_coworker__process_cfe_receipt
 *
 * Coworker variant — the coworker forwards a CFE receipt and tells us which
 * client phone the quote should land in. Stateless: no leads DB, no lead
 * persistence, just parse → render quote → deliver PDF + summary.
 */
import path from "node:path";
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  ParseAndQuoteResult,
} from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface ProcessCFEReceiptParams {
  mediaPath: string;
  /** Phone number (E.164 without +) of the client the coworker wants this quote sent to. Required. */
  clientPhone: string;
  /** Coworker's own phone (E.164 without +). Used as a fallback delivery target when set. */
  coworkerPhone?: string;
}

export interface ProcessCFEReceiptDeps {
  parseAndQuote: ParseAndQuoteClient["quote"];
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const ERR_INTERNAL = "Tuvimos un problema generando la cotización. Intenta de nuevo en un momento.";
const ACK_PROCESSING = "Recibí el recibo, lo estoy procesando. Un momento por favor...";

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
        "Phone (E.164 without +) of the client this quote belongs to. Required — the coworker MUST tell us where to deliver.",
    },
    coworkerPhone: {
      type: "string" as const,
      description:
        "Optional. Coworker's own phone if the quote should also be acknowledged to them.",
    },
  },
  required: ["mediaPath", "clientPhone"],
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
  clientPhone: string;
  coworkerPhone?: string;
  mediaPath: string;
  error: unknown;
  requestId?: string;
  code?: string;
}): string {
  const lines = [
    "🚨 Solayre coworker quote failed",
    `Stage: ${params.stage}`,
    `Client: ${params.clientPhone}`,
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
    "Process a CFE receipt forwarded by a coworker and deliver the quote PDF + summary to the " +
    "client phone the coworker provided. Stateless — does not persist as a lead. Use this when " +
    "the coworker says 'here's a receipt for client X, send them a quote'.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessCFEReceiptParams,
    deps: ProcessCFEReceiptDeps,
  ): Promise<ProcessCFEReceiptResult> => {
    const { mediaPath, clientPhone, coworkerPhone } = params;
    const { runtime, parseAndQuote, downloadFile, outputDir } = deps;

    if (!mediaPath || !clientPhone) {
      return { success: false, error: "mediaPath and clientPhone are required" };
    }

    const ackTarget = coworkerPhone || clientPhone;
    try {
      await runtime.sendMessage(ackTarget, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "solayre-quotes-coworker:ack" },
      });
    } catch (err) {
      console.warn("[solayre-quotes-coworker] ack failed:", err);
    }

    let parsed: ParseAndQuoteResult | ParseAndQuoteError;
    try {
      parsed = await parseAndQuote({ mediaPath, phoneNumber: clientPhone });
    } catch (err) {
      console.error("[solayre-quotes-coworker] parseAndQuote threw:", err);
      await alertFailure(runtime, {
        stage: "parseAndQuote:throw",
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
      await runtime.sendMessage(clientPhone, {
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
        error: "Cotización generada pero falló la entrega al cliente.",
      };
    }

    return {
      success: true,
      quoteId: parsed.quoteId,
      quoteNumber: parsed.quoteNumber,
      pdfPath: destPath,
      pdfUrl: parsed.pdfUrl,
    };
  },
};
