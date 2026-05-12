/**
 * Tool: process_cfe_receipt
 *
 * End-to-end CFE receipt → cotización pipeline for the coworker flow.
 * Single Supabase endpoint (parse-and-quote) handles parsing, official XML
 * download, and quote calculation. This tool persists the lead, downloads
 * the PDF locally, and delivers a single summary message + attachment.
 */
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  ParseAndQuoteResult,
} from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface ProcessCFEReceiptParams {
  mediaPath: string;
  coworkerPhone: string;
}

export interface ProcessCFEReceiptDeps {
  parseAndQuote: ParseAndQuoteClient["quote"];
  saveLead: (input: { phone: string; name: string; notes?: string }) => Promise<{ leadId: number }>;
  saveQuoteId: (input: { leadId: number; quoteId: string; quoteNumber: string }) => Promise<void>;
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const ERR_INTERNAL = "Hubo un problema procesando el recibo. Aleyda revisará en cuanto pueda.";
const ACK_PROCESSING = "Procesando recibo, dame un momento...";

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    mediaPath: {
      type: "string" as const,
      description:
        "Absolute path to the inbound CFE receipt file (image or PDF) sent by the coworker",
    },
    coworkerPhone: {
      type: "string" as const,
      description:
        "Phone number of the coworker who sent the receipt (E.164 without +). Use the SENDER of the inbound message — never the lead/customer phone.",
    },
  },
  required: ["mediaPath", "coworkerPhone"],
};

export interface ProcessCFEReceiptResult {
  success: boolean;
  leadId?: number;
  sentToCoworker?: boolean;
  error?: string;
}

export const processCFEReceiptTool = {
  name: "process_cfe_receipt",
  description:
    "Process a CFE receipt (image or PDF) end-to-end via the consolidated parse-and-quote " +
    "endpoint: parse, download official XML, calculate solar quote, and deliver the quote PDF " +
    "+ summary to the coworker via WhatsApp. ATOMIC: returns success only after everything " +
    "completes. On any failure, sends a clear error message to the coworker and returns " +
    "success=false. Use this as the SINGLE tool call when a coworker forwards a CFE receipt.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessCFEReceiptParams,
    deps: ProcessCFEReceiptDeps,
  ): Promise<ProcessCFEReceiptResult> => {
    const { mediaPath, coworkerPhone } = params;
    const { runtime } = deps;

    const sendErr = async (text: string): Promise<ProcessCFEReceiptResult> => {
      try {
        await runtime.sendMessage(coworkerPhone, {
          text,
          metadata: { openclawInitiated: true, source: "process_cfe_receipt:error" },
        });
      } catch (err) {
        console.error("[process_cfe_receipt] sendErr failed:", err);
      }
      return { success: false, error: text };
    };

    if (!mediaPath || !coworkerPhone) {
      return { success: false, error: "mediaPath and coworkerPhone are required" };
    }

    // 1. Ack
    try {
      await runtime.sendMessage(coworkerPhone, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "process_cfe_receipt:ack" },
      });
    } catch (err) {
      console.error("[process_cfe_receipt] ack send failed (continuing):", err);
    }

    // 2. Single API call — parse + quote
    let result: ParseAndQuoteResult | ParseAndQuoteError;
    try {
      result = await deps.parseAndQuote({ mediaPath, phoneNumber: coworkerPhone });
    } catch (err) {
      console.error("[process_cfe_receipt] parseAndQuote threw:", err);
      return await sendErr(ERR_INTERNAL);
    }
    if (!result.success) {
      console.error("[process_cfe_receipt] parseAndQuote failed:", result.error);
      return await sendErr(ERR_INTERNAL);
    }

    const customerName = result.cfe?.data?.customerName?.trim() || "Cliente";
    const serviceNumber = result.cfe?.data?.serviceNumber;

    // 3. Persist lead under coworker phone
    let leadId: number;
    try {
      const saved = await deps.saveLead({
        phone: coworkerPhone,
        name: customerName,
        notes: `Cotización solicitada por coworker. RPU ${serviceNumber ?? "?"}. Cotización ${result.quoteNumber}.`,
      });
      leadId = saved.leadId;
    } catch (err) {
      console.error("[process_cfe_receipt] saveLead failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    // 4. Save quote reference (best-effort)
    try {
      await deps.saveQuoteId({
        leadId,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
      });
    } catch (err) {
      console.error("[process_cfe_receipt] saveQuoteId failed (continuing):", err);
    }

    // 5. Download quote PDF locally
    let quotePdfPath: string;
    try {
      quotePdfPath = await deps.downloadFile(
        result.pdfUrl,
        `${deps.outputDir}/cotizacion-${leadId}-${Date.now()}.pdf`,
      );
    } catch (err) {
      console.error("[process_cfe_receipt] downloadFile failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    // 6. Send summary + attachment
    const summary = buildSummaryMessage({
      titular: customerName,
      rpu: serviceNumber,
      tariff: result.cfe?.data?.tariffType,
      annualKwh: result.cfe?.data?.annualConsumption,
      quote: result.quote,
      quoteNumber: result.quoteNumber,
    });

    try {
      await runtime.sendMessage(coworkerPhone, {
        text: summary,
        metadata: {
          openclawInitiated: true,
          source: "process_cfe_receipt:result",
          filePath: quotePdfPath,
        },
      });
    } catch (err) {
      console.error("[process_cfe_receipt] final send failed:", err);
      return { success: false, error: "send_failed", leadId };
    }

    return { success: true, leadId, sentToCoworker: true };
  },
};

function buildSummaryMessage(input: {
  titular: string;
  rpu?: string;
  tariff?: string;
  annualKwh?: number;
  quote: ParseAndQuoteResult["quote"];
  quoteNumber: string;
}): string {
  const fmt = (n?: number): string =>
    typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString("es-MX")}` : "—";
  const kwh = (n?: number): string =>
    typeof n === "number" && Number.isFinite(n)
      ? `${Math.round(n).toLocaleString("es-MX")} kWh`
      : "—";

  return [
    `Cotización lista para *${input.titular}*`,
    `Folio: ${input.quoteNumber}`,
    "",
    `*Datos del recibo*`,
    `• RPU: ${input.rpu ?? "—"}`,
    `• Tarifa: ${input.tariff ?? "—"}`,
    `• Consumo anual: ${kwh(input.annualKwh)}`,
    "",
    `*Sistema propuesto*`,
    `• Paneles: ${input.quote.panelCount}`,
    `• Cobertura: ${input.quote.coveragePercent}%`,
    `• Inversión contado: ${fmt(input.quote.cashPrice)}`,
    `• Inversión total: ${fmt(input.quote.listPrice)}`,
    `• Ahorro anual: ${fmt(input.quote.annualSavings)}`,
    `• ROI: ${input.quote.paybackYears.toFixed(1)} años`,
  ].join("\n");
}
