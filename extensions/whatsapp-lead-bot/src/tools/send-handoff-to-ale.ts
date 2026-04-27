import type { Database } from "../database.js";
import type { HandoffManager } from "../handoff/manager.js";
import type { LabelService } from "../labels.js";
import {
  handoffAgentMessage,
  handoffCustomerAckMessage,
} from "../messages/handoff-template.js";
import type { Runtime } from "../runtime.js";

export interface SendHandoffToAleContext {
  db: Database;
  runtime: Runtime;
  labelService: LabelService;
  handoffManager: HandoffManager;
  agentNumbers: readonly string[];
}

export interface SendHandoffToAleParams {
  phone: string;
}

export const sendHandoffToAleTool = {
  name: "send_handoff_to_ale",
  description:
    "Hand off a lead to the human sales agent (Ale). Sends the canonical acknowledgement to the lead, marks them handed_off, and notifies configured agent numbers with a natural-language summary of the lead. Use this when the lead asks for a visit or otherwise wants to talk to a human. The customer-facing text is fixed server-side.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
    },
    required: ["phone"],
  },
  execute: async (
    params: SendHandoffToAleParams,
    context: SendHandoffToAleContext,
  ): Promise<{ success: boolean; error?: string; lead?: unknown }> => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.runtime.sendMessage(params.phone, {
      text: handoffCustomerAckMessage(),
      metadata: { openclawInitiated: true, source: "send_handoff_to_ale" },
    });

    await context.handoffManager.triggerHandoff(lead.id, "visita_solicitada", "tool");

    try {
      await context.labelService.applyStatus(params.phone, "handed_off", context.runtime);
    } catch (err) {
      console.error(`[send_handoff_to_ale] Failed to apply HUMANO label: ${String(err)}`);
    }

    const updated = await context.db.getLeadById(lead.id);

    if (updated && context.agentNumbers.length > 0) {
      const summary = handoffAgentMessage(updated);
      for (const agentPhone of context.agentNumbers) {
        try {
          await context.runtime.sendMessage(agentPhone, {
            text: summary,
            metadata: { openclawInitiated: true, source: "send_handoff_to_ale" },
          });
        } catch (err) {
          console.error(`[send_handoff_to_ale] Failed to notify ${agentPhone}: ${String(err)}`);
        }
      }
    }

    return { success: true, lead: updated };
  },
};
