import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import {
  disqualificationMessage,
  isDisqualificationReason,
  type DisqualificationReason,
} from "../messages/disqualification-template.js";
import type { Runtime } from "../runtime.js";

export interface SendDisqualificationContext {
  db: Database;
  labelService: LabelService;
  runtime: Runtime;
}

export interface SendDisqualificationParams {
  phone: string;
  reason: DisqualificationReason;
}

export const sendDisqualificationTool = {
  name: "send_disqualification",
  description:
    "Send a canonical disqualification message to a lead and mark them disqualified. Use this for OUT leads (outside Sinaloa, tenant, bill below $500). The message text is fixed server-side — do not write the message yourself.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: {
        type: "string" as const,
        description: "Phone number (E.164 without +)",
      },
      reason: {
        type: "string" as const,
        enum: ["out_of_state", "tenant", "low_bill"],
        description:
          "Why the lead is disqualified. out_of_state: outside Sinaloa. tenant: not the property owner. low_bill: bimonthly bill below $500.",
      },
    },
    required: ["phone", "reason"],
  },
  execute: async (
    params: SendDisqualificationParams,
    context: SendDisqualificationContext,
  ): Promise<{ success: boolean; error?: string; lead?: unknown }> => {
    if (!isDisqualificationReason(params.reason)) {
      return { success: false, error: `Invalid reason: ${String(params.reason)}` };
    }

    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    const text = disqualificationMessage(params.reason);
    await context.runtime.sendMessage(params.phone, {
      text,
      metadata: { openclawInitiated: true, source: "send_disqualification" },
    });

    await context.db.updateLeadStatus(lead.id, "ignored");
    await context.db.logHandoffEvent(lead.id, "disqualified", "tool", {
      reason: params.reason,
    });

    try {
      await context.labelService.applyStatus(params.phone, "ignored", context.runtime);
    } catch (err) {
      console.error(`[send_disqualification] Failed to apply label: ${String(err)}`);
    }

    const updated = await context.db.getLeadById(lead.id);
    return { success: true, lead: updated };
  },
};
