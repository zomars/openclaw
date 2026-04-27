import type { Database } from "../database.js";
import { buildQuoteMessages, type QuoteTemplateInput } from "../messages/quote-template.js";
import type { Runtime } from "../runtime.js";

/**
 * Result returned by the quote calculator. The plugin maps the upstream
 * Supabase response into this shape; the tool only depends on the interface.
 */
export interface QuoteResult extends QuoteTemplateInput {
  panelCount: number;
  pdfUrl: string | null;
}

export type QuoteCalculator = (billId: string) => Promise<
  | { success: true; quote: QuoteResult }
  | { success: false; error: string }
>;

export interface SendQuoteSequenceContext {
  db: Database;
  runtime: Runtime;
  calculate: QuoteCalculator;
  /** Optional delay between messages so they arrive ordered on the device. */
  interMessageDelayMs?: number;
}

export interface SendQuoteSequenceParams {
  phone: string;
  billId: string;
}

const DEFAULT_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const sendQuoteSequenceTool = {
  name: "send_quote_sequence",
  description:
    "Send the canonical 6-step solar quote to a lead. Calculates pricing from the parsed bill, sends pain reflection, 25-year projection, system description, pricing/financing, the PDF, and the ROI close — all with fixed templates. Atomically updates the lead with quoted system size and prices. Use this exclusively to quote — never write pricing or financing in free text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      billId: {
        type: "string" as const,
        description: "UUID of the parsed CFE bill (from parse_cfe_receipt)",
      },
    },
    required: ["phone", "billId"],
  },
  execute: async (
    params: SendQuoteSequenceParams,
    context: SendQuoteSequenceContext,
  ): Promise<{ success: boolean; error?: string; lead?: unknown }> => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    const calc = await context.calculate(params.billId);
    if (!calc.success) {
      return { success: false, error: calc.error };
    }

    const { quote } = calc;
    const messages = buildQuoteMessages(quote);
    const delay = context.interMessageDelayMs ?? DEFAULT_DELAY_MS;

    // Send steps 1-4 sequentially.
    for (let i = 0; i < 4; i++) {
      await context.runtime.sendMessage(params.phone, {
        text: messages[i],
        metadata: {
          openclawInitiated: true,
          source: "send_quote_sequence",
          step: i + 1,
        },
      });
      if (delay > 0) await sleep(delay);
    }

    // Step 5: PDF as document attachment if available, otherwise as text only.
    if (quote.pdfUrl) {
      await context.runtime.sendMessage(params.phone, {
        text: messages[4],
        metadata: {
          openclawInitiated: true,
          source: "send_quote_sequence",
          step: 5,
          filePath: quote.pdfUrl,
        },
      });
    } else {
      await context.runtime.sendMessage(params.phone, {
        text: messages[4],
        metadata: { openclawInitiated: true, source: "send_quote_sequence", step: 5 },
      });
    }
    if (delay > 0) await sleep(delay);

    // Step 6: ROI close.
    await context.runtime.sendMessage(params.phone, {
      text: messages[5],
      metadata: { openclawInitiated: true, source: "send_quote_sequence", step: 6 },
    });

    // Atomic lead update — this tool is the single owner of these fields.
    await context.db.updateQuoteData(lead.id, {
      panels_quoted: quote.panelCount,
      quote_cash: quote.cashPrice,
      quote_financed: quote.financedPrice,
    });
    await context.db.updateLeadStatus(lead.id, "qualified");

    const updated = await context.db.getLeadById(lead.id);
    return { success: true, lead: updated };
  },
};
