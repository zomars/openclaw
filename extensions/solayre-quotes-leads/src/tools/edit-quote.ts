/**
 * Tool: solayre_quotes_leads__edit_quote
 *
 * Revise an existing quote and deliver the new PDF to the lead. Stateless —
 * the leads DB is not touched.
 */
import path from "node:path";
import type { ParseAndQuoteClient } from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface EditQuoteParams {
  quoteNumber: string;
  leadPhone: string;
  panels?: number;
  totalInvestment?: number;
  inverterKw?: number;
  targetCoverage?: number;
  clientInfo?: {
    name?: string;
    phone?: string;
    email?: string;
    city?: string;
    serviceNumber?: string;
    serviceAddress?: string;
  };
}

export interface EditQuoteDeps {
  editQuote: ParseAndQuoteClient["editQuote"];
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    quoteNumber: {
      type: "string" as const,
      description: "Folio of the existing quote to revise.",
    },
    leadPhone: {
      type: "string" as const,
      description: "Phone (E.164 without +) of the lead to receive the revised PDF.",
    },
    panels: { type: "number" as const },
    totalInvestment: { type: "number" as const },
    inverterKw: { type: "number" as const },
    targetCoverage: { type: "number" as const, description: "Target coverage percent (0-100)." },
    clientInfo: { type: "object" as const, additionalProperties: true },
  },
  required: ["quoteNumber", "leadPhone"],
};

export interface EditQuoteResult {
  success: boolean;
  quoteId?: string;
  quoteNumber?: string;
  version?: number;
  pdfPath?: string;
  pdfUrl?: string;
  error?: string;
}

export const editQuoteLeadsTool = {
  name: "solayre_quotes_leads__edit_quote",
  description:
    "Revise an existing quote and send the new PDF to the lead. Stateless — chain " +
    "`save_lead` afterward to persist the new quote_id on the lead row.",
  inputSchema: inputJsonSchema,
  execute: async (params: EditQuoteParams, deps: EditQuoteDeps): Promise<EditQuoteResult> => {
    const { quoteNumber, leadPhone, ...rest } = params;
    if (!quoteNumber || !leadPhone) {
      return { success: false, error: "quoteNumber and leadPhone are required" };
    }

    const result = await deps.editQuote({ quoteNumber, ...rest });
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const destPath = path.join(deps.outputDir, `${result.quoteNumber}-v${result.version}.pdf`);
    try {
      await deps.downloadFile(result.pdfUrl, destPath);
    } catch (err) {
      console.error("[solayre-quotes-leads] edit_quote downloadFile failed:", err);
      return {
        success: false,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
        version: result.version,
        error: "Cotización revisada pero falló la descarga del PDF.",
      };
    }

    try {
      await deps.runtime.sendMessage(leadPhone, {
        text: `Cotización actualizada ${result.quoteNumber} v${result.version}`,
        metadata: {
          openclawInitiated: true,
          source: "solayre-quotes-leads:edit",
          attachments: [{ path: destPath, contentType: "application/pdf" }],
        },
      });
    } catch (err) {
      console.error("[solayre-quotes-leads] edit_quote delivery failed:", err);
      return {
        success: false,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
        version: result.version,
        pdfPath: destPath,
        error: "Cotización revisada pero falló la entrega al lead.",
      };
    }

    return {
      success: true,
      quoteId: result.quoteId,
      quoteNumber: result.quoteNumber,
      version: result.version,
      pdfPath: destPath,
      pdfUrl: result.pdfUrl,
    };
  },
};
