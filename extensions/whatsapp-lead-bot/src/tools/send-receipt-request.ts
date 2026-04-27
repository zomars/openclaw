import type { Database } from "../database.js";
import { receiptRequestMessage } from "../messages/receipt-request-template.js";
import type { Runtime } from "../runtime.js";

export interface SendReceiptRequestContext {
  db: Database;
  runtime: Runtime;
}

export interface SendReceiptRequestParams {
  phone: string;
}

export const sendReceiptRequestTool = {
  name: "send_receipt_request",
  description:
    "Send the canonical CFE receipt request message to a lead. Use this exactly once when the lead has reported a bimonthly bill but has not yet shared a CFE receipt. The text is fixed server-side — do not write the request yourself.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
    },
    required: ["phone"],
  },
  execute: async (
    params: SendReceiptRequestParams,
    context: SendReceiptRequestContext,
  ): Promise<{ success: boolean; error?: string }> => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.runtime.sendMessage(params.phone, {
      text: receiptRequestMessage(),
      metadata: { openclawInitiated: true, source: "send_receipt_request" },
    });

    return { success: true };
  },
};
