/**
 * Tool: edit_quote
 *
 * Coworker-only revision of an existing quote. Calls the synchronous
 * calculate-quote endpoint, downloads the new PDF, sends summary + attachment
 * to the coworker, and updates the lead's stored quoteId/quoteNumber.
 *
 * Each revision creates a new server-side quote linked to the original via
 * parentQuoteId with an incremented version.
 */

import type {
  EditQuoteInput,
  EditQuoteResult,
  ParseAndQuoteClient,
  ParseAndQuoteError,
} from "../cfe/parse-and-quote-client.js";
import type { Database } from "../database.js";
import type { Runtime } from "../runtime.js";

export interface EditQuoteToolDeps {
  editQuote: ParseAndQuoteClient["editQuote"];
  db: Database;
  runtime: Runtime;
  downloadFile: (url: string, destPath: string) => Promise<string>;
  outputDir: string;
}

export interface EditQuoteToolParams {
  /** Folio of the original quote (e.g. "SOL20260402-170c") or quoteId UUID. */
  quoteNumber: string;
  /** Coworker phone (E.164 without +) — message recipient. */
  coworkerPhone: string;
  panels?: number;
  totalInvestment?: number;
  inverterKw?: number;
  targetCoverage?: number;
  clientInfo?: EditQuoteInput["clientInfo"];
}

export interface EditQuoteToolResult {
  success: boolean;
  leadId?: number;
  quoteId?: string;
  quoteNumber?: string;
  version?: number;
  sentToCoworker?: boolean;
  error?: string;
}

const ERR_INTERNAL = "Hubo un problema actualizando la cotización. Aleyda lo revisará.";
const ACK_PROCESSING = "Actualizando cotización, dame un momento...";

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    quoteNumber: {
      type: "string" as const,
      description:
        "Folio de la cotización original (e.g. SOL20260402-170c) o UUID quoteId. Requerido.",
    },
    coworkerPhone: {
      type: "string" as const,
      description: "Teléfono del coworker (E.164 sin +). Recibe el mensaje y el PDF.",
    },
    panels: {
      type: "number" as const,
      description: "Cantidad de paneles. El motor recalcula cobertura, ahorro y ROI.",
    },
    totalInvestment: {
      type: "number" as const,
      description: "Precio final deseado en efectivo (MXN). El motor deriva el descuento.",
    },
    inverterKw: {
      type: "number" as const,
      description: "kW del inversor (solo display, no afecta cálculos de energía).",
    },
    targetCoverage: {
      type: "number" as const,
      description: "Cobertura deseada 0-100%. Alternativa a panels.",
    },
    clientInfo: {
      type: "object" as const,
      description: "Actualizar datos del cliente. Solo enviar campos que cambian.",
      properties: {
        name: { type: "string" as const },
        phone: { type: "string" as const },
        email: { type: "string" as const },
        city: { type: "string" as const },
        serviceNumber: { type: "string" as const },
        serviceAddress: { type: "string" as const },
      },
      additionalProperties: false,
    },
  },
  required: ["quoteNumber", "coworkerPhone"],
  additionalProperties: false,
};

export const editQuoteTool = {
  name: "edit_quote",
  description:
    "Genera una nueva versión de una cotización existente (paneles, precio total, cobertura, " +
    "datos del cliente). Solo para coworkers. Llama al endpoint calculate-quote, descarga el " +
    "PDF resultante y lo envía al coworker. Cada llamada produce un quoteNumber nuevo con " +
    "version incrementada y parentQuoteId apuntando al original. Usar cuando el coworker " +
    "pide ajustar una cotización ya entregada (no para nuevas cotizaciones desde recibo CFE).",
  inputSchema: inputJsonSchema,
  execute: async (
    params: EditQuoteToolParams,
    deps: EditQuoteToolDeps,
  ): Promise<EditQuoteToolResult> => {
    const { quoteNumber, coworkerPhone } = params;
    const { runtime } = deps;

    const sendErr = async (text: string): Promise<EditQuoteToolResult> => {
      try {
        await runtime.sendMessage(coworkerPhone, {
          text,
          metadata: { openclawInitiated: true, source: "edit_quote:error" },
        });
      } catch (err) {
        console.error("[edit_quote] sendErr failed:", err);
      }
      return { success: false, error: text };
    };

    if (!quoteNumber || !coworkerPhone) {
      return { success: false, error: "quoteNumber and coworkerPhone are required" };
    }

    try {
      await runtime.sendMessage(coworkerPhone, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "edit_quote:ack" },
      });
    } catch (err) {
      console.error("[edit_quote] ack send failed (continuing):", err);
    }

    let result: EditQuoteResult | ParseAndQuoteError;
    try {
      result = await deps.editQuote({
        quoteNumber,
        ...(typeof params.panels === "number" ? { panels: params.panels } : {}),
        ...(typeof params.totalInvestment === "number"
          ? { totalInvestment: params.totalInvestment }
          : {}),
        ...(typeof params.inverterKw === "number" ? { inverterKw: params.inverterKw } : {}),
        ...(typeof params.targetCoverage === "number"
          ? { targetCoverage: params.targetCoverage }
          : {}),
        ...(params.clientInfo ? { clientInfo: params.clientInfo } : {}),
      });
    } catch (err) {
      console.error("[edit_quote] editQuote threw:", err);
      return await sendErr(ERR_INTERNAL);
    }
    if (!result.success) {
      console.error("[edit_quote] editQuote failed:", result.error);
      return await sendErr(ERR_INTERNAL);
    }

    // Update the coworker's lead record with the new quote reference.
    let leadId: number | undefined;
    try {
      const lead = await deps.db.getLeadByPhone(coworkerPhone);
      if (lead) {
        leadId = lead.id;
        await deps.db.updateQuoteData(lead.id, {
          notes: JSON.stringify({
            quoteId: result.quoteId,
            quoteNumber: result.quoteNumber,
            version: result.version,
            parentQuoteId: result.parentQuoteId,
          }),
          quoted_at: Date.now(),
        });
      }
    } catch (err) {
      console.error("[edit_quote] updateQuoteData failed (continuing):", err);
    }

    let pdfPath: string;
    try {
      pdfPath = await deps.downloadFile(
        result.pdfUrl,
        `${deps.outputDir}/cotizacion-rev-${result.quoteNumber}-${Date.now()}.pdf`,
      );
    } catch (err) {
      console.error("[edit_quote] downloadFile failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    const summary = buildRevisionSummary(result);
    try {
      await runtime.sendMessage(coworkerPhone, {
        text: summary,
        metadata: {
          openclawInitiated: true,
          source: "edit_quote:result",
          filePath: pdfPath,
        },
      });
    } catch (err) {
      console.error("[edit_quote] final send failed:", err);
      return {
        success: false,
        error: "send_failed",
        leadId,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
        version: result.version,
      };
    }

    return {
      success: true,
      leadId,
      quoteId: result.quoteId,
      quoteNumber: result.quoteNumber,
      version: result.version,
      sentToCoworker: true,
    };
  },
};

function buildRevisionSummary(result: EditQuoteResult): string {
  const fmt = (n?: number): string =>
    typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString("es-MX")}` : "—";

  const lines: string[] = [
    `Cotización actualizada (v${result.version})`,
    `Folio: ${result.quoteNumber}`,
  ];
  if (result.quote) {
    lines.push(
      "",
      `*Sistema*`,
      `• Paneles: ${result.quote.panelCount}`,
      `• Cobertura: ${result.quote.coveragePercent}%`,
      `• Inversión contado: ${fmt(result.quote.cashPrice)}`,
      `• Inversión total: ${fmt(result.quote.listPrice)}`,
      `• Ahorro anual: ${fmt(result.quote.annualSavings)}`,
      `• ROI: ${result.quote.paybackYears.toFixed(1)} años`,
    );
  }
  return lines.join("\n");
}
