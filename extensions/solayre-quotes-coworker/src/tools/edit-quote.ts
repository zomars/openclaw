/**
 * Tool: solayre_quotes_coworker__edit_quote
 *
 * Revise an existing quote via the calculate-quote endpoint and deliver the
 * new PDF to the same client phone the coworker provided. Stateless — does
 * not update any leads-side state.
 */
import path from "node:path";
import type { ParseAndQuoteClient } from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface EditQuoteParams {
  quoteNumber: string;
  clientPhone: string;
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
      description: "Folio of the existing quote to revise (e.g. SOL20260513-2117).",
    },
    clientPhone: {
      type: "string" as const,
      description: "Phone (E.164 without +) of the client to receive the revised PDF.",
    },
    panels: { type: "number" as const },
    totalInvestment: { type: "number" as const },
    inverterKw: { type: "number" as const },
    targetCoverage: {
      type: "number" as const,
      description: "Target coverage percent (0-100).",
    },
    clientInfo: {
      type: "object" as const,
      additionalProperties: true,
    },
  },
  required: ["quoteNumber", "clientPhone"],
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

export const editQuoteCoworkerTool = {
  name: "solayre_quotes_coworker__edit_quote",
  description:
    "Revise an existing quote and send the new PDF to the client phone provided by the " +
    "coworker. Stateless — leads-side state is not touched.",
  inputSchema: inputJsonSchema,
  execute: async (params: EditQuoteParams, deps: EditQuoteDeps): Promise<EditQuoteResult> => {
    const { quoteNumber, clientPhone, ...rest } = params;
    if (!quoteNumber || !clientPhone) {
      return { success: false, error: "quoteNumber and clientPhone are required" };
    }

    const result = await deps.editQuote({ quoteNumber, ...rest });
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const destPath = path.join(deps.outputDir, `${result.quoteNumber}-v${result.version}.pdf`);
    try {
      await deps.downloadFile(result.pdfUrl, destPath);
    } catch (err) {
      console.error("[solayre-quotes-coworker] edit_quote downloadFile failed:", err);
      return {
        success: false,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
        version: result.version,
        error: "Cotización revisada pero falló la descarga del PDF.",
      };
    }

    try {
      await deps.runtime.sendMessage(clientPhone, {
        text: `Cotización actualizada ${result.quoteNumber} v${result.version}`,
        metadata: {
          openclawInitiated: true,
          source: "solayre-quotes-coworker:edit",
          attachments: [{ path: destPath, contentType: "application/pdf" }],
        },
      });
    } catch (err) {
      console.error("[solayre-quotes-coworker] edit_quote delivery failed:", err);
      return {
        success: false,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
        version: result.version,
        pdfPath: destPath,
        error: "Cotización revisada pero falló la entrega al cliente.",
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
