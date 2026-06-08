/**
 * Tools for previous quote lookup + PDF resend.
 *
 * The external quote API owns fuzzy search and PDF URL generation. This plugin
 * orchestrates the coworker workflow: search first, then send when the API
 * returns a clear result or the caller provides an explicit quote identifier/version.
 */
import path from "node:path";
import type {
  PreviousQuoteMatch,
  PreviousQuoteSearchInput,
  PreviousQuoteSearchResult,
  PreviousQuoteSendPdfInput,
  PreviousQuoteSendPdfResult,
  PreviousQuoteClient,
} from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface SearchPreviousQuotesParams extends PreviousQuoteSearchInput {}

export interface SendPreviousQuotePdfParams extends PreviousQuoteSearchInput {
  /** Explicit quote folio to send. Prefer this after disambiguation. */
  quoteNumber?: string;
  /** Explicit quote UUID to send, if available. */
  quoteId?: string;
  /** Optional version when coworker selects a specific revision. */
  version?: number;
}

export interface PreviousQuoteDeps {
  searchQuotes: PreviousQuoteClient["searchQuotes"];
  sendQuotePdf: PreviousQuoteClient["sendQuotePdf"];
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const matchSchema = {
  type: "object" as const,
  additionalProperties: true,
};

const searchInputJsonSchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "Natural-language search from the coworker, e.g. 'la de Bertha de 3 paneles'.",
    },
    coworkerPhone: {
      type: "string" as const,
      description: "Coworker's phone (E.164 without +). Used to scope internal access.",
    },
    limit: { type: "number" as const, description: "Maximum matches to return. Default 5." },
  },
  required: ["query", "coworkerPhone"],
};

const sendInputJsonSchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description:
        "Natural-language search from the coworker. Used when quoteNumber/quoteId is not supplied.",
    },
    coworkerPhone: {
      type: "string" as const,
      description: "Coworker's phone (E.164 without +). The PDF is sent to this coworker.",
    },
    quoteNumber: {
      type: "string" as const,
      description: "Explicit quote folio to send, e.g. SOL20260513-2117.",
    },
    quoteId: { type: "string" as const, description: "Explicit quote UUID to send." },
    version: { type: "number" as const, description: "Specific quote version to send." },
    limit: {
      type: "number" as const,
      description: "Maximum search matches to evaluate. Default 5.",
    },
  },
  required: ["coworkerPhone"],
};

function shortMatch(match: PreviousQuoteMatch): Record<string, unknown> {
  return {
    quoteId: match.quoteId,
    quoteNumber: match.quoteNumber,
    version: match.version,
    parentQuoteNumber: match.parentQuoteNumber,
    clientName: match.clientName,
    clientPhone: match.clientPhone,
    city: match.city,
    panels: match.panels,
    totalInvestment: match.totalInvestment,
    createdAt: match.createdAt,
    confidence: match.confidence,
    matchReason: match.matchReason,
  };
}

function isSafeAutoSend(search: PreviousQuoteSearchResult): boolean {
  if (!search.success || search.matches.length !== 1) return false;
  const suggestion = search.suggestion ?? (search.needsClarification ? "disambiguate" : undefined);
  const confidence = search.matches[0]?.confidence ?? 0;
  return suggestion === "send" || (!search.needsClarification && confidence >= 0.85);
}

function filenameFor(quoteNumber: string | undefined, version: number | undefined): string {
  const base = quoteNumber?.replace(/[^a-zA-Z0-9._-]/g, "_") || `quote-${Date.now()}`;
  return version ? `${base}-v${version}.pdf` : `${base}.pdf`;
}

export const searchPreviousQuotesCoworkerTool = {
  name: "solayre_quotes_coworker__search_previous_quotes",
  description:
    "Search previous Solayre quotes with fuzzy/natural-language matching. Returns candidates only; " +
    "does not send PDFs. Use before sending when the coworker request is ambiguous.",
  inputSchema: searchInputJsonSchema,
  execute: async (
    params: SearchPreviousQuotesParams,
    deps: PreviousQuoteDeps,
  ): Promise<PreviousQuoteSearchResult> => {
    if (!params.query || !params.coworkerPhone) {
      return {
        success: false,
        error: "query and coworkerPhone are required",
        matches: [],
        needsClarification: false,
        suggestion: "ask_more",
      };
    }
    return deps.searchQuotes(params);
  },
};

export const sendPreviousQuotePdfCoworkerTool = {
  name: "solayre_quotes_coworker__send_previous_quote_pdf",
  description:
    "Find and send a previous quote PDF for a coworker request. If several matches look plausible, " +
    "returns candidates so the coworker can pick the right one.",
  inputSchema: sendInputJsonSchema,
  execute: async (
    params: SendPreviousQuotePdfParams,
    deps: PreviousQuoteDeps,
  ): Promise<
    | (PreviousQuoteSendPdfResult & { delivered?: boolean; pdfPath?: string })
    | (PreviousQuoteSearchResult & { delivered: false })
  > => {
    const { coworkerPhone, quoteNumber, quoteId, version } = params;
    if (!coworkerPhone) {
      return {
        success: false,
        error: "coworkerPhone is required",
        matches: [],
        needsClarification: false,
        suggestion: "ask_more",
        delivered: false,
      };
    }

    let selected: { quoteNumber?: string; quoteId?: string; version?: number } = {
      quoteNumber,
      quoteId,
      version,
    };

    if (!selected.quoteNumber && !selected.quoteId) {
      if (!params.query) {
        return {
          success: false,
          error: "query, quoteNumber, or quoteId is required",
          matches: [],
          needsClarification: false,
          suggestion: "ask_more",
          delivered: false,
        };
      }
      const search = await deps.searchQuotes(params);
      if (!isSafeAutoSend(search)) {
        return { ...search, matches: search.matches.map((m) => m), delivered: false };
      }
      const match = search.matches[0];
      selected = {
        quoteNumber: match.quoteNumber,
        quoteId: match.quoteId,
        version: match.version,
      };
    }

    const pdfResult = await deps.sendQuotePdf({
      coworkerPhone,
      quoteNumber: selected.quoteNumber,
      quoteId: selected.quoteId,
      version: selected.version,
    });
    if (!pdfResult.success || !pdfResult.pdfUrl) {
      return { ...pdfResult, delivered: false };
    }

    const destPath = path.join(
      deps.outputDir,
      filenameFor(pdfResult.quoteNumber, pdfResult.version),
    );
    try {
      await deps.downloadFile(pdfResult.pdfUrl, destPath);
    } catch (err) {
      console.error("[solayre-quotes-coworker] previous_quote downloadFile failed:", err);
      return {
        ...pdfResult,
        success: false,
        error: "Cotización encontrada pero falló la descarga del PDF.",
        delivered: false,
      };
    }

    try {
      const label = [pdfResult.quoteNumber, pdfResult.version ? `v${pdfResult.version}` : undefined]
        .filter(Boolean)
        .join(" ");
      await deps.runtime.sendMessage(coworkerPhone, {
        text: `Te envío la cotización ${label}.`,
        metadata: {
          openclawInitiated: true,
          source: "solayre-quotes-coworker:previous-quote",
          attachments: [{ path: destPath, contentType: "application/pdf" }],
        },
      });
    } catch (err) {
      console.error("[solayre-quotes-coworker] previous_quote delivery failed:", err);
      return {
        ...pdfResult,
        pdfPath: destPath,
        success: false,
        error: "Cotización encontrada pero falló la entrega al coworker.",
        delivered: false,
      };
    }

    return { ...pdfResult, pdfPath: destPath, delivered: true };
  },
};
