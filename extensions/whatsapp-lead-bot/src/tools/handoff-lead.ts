/**
 * Tool: handoff_lead
 *
 * Marks a lead as handed off to a human agent, applies the HUMANO label,
 * and notifies configured agent numbers.
 */

import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { Runtime } from "../runtime.js";

export interface HandoffLeadContext {
  db: Database;
  labelService: LabelService;
  runtime: Runtime;
  agentNotifier?: AgentNotifier;
}

export const handoffLeadTool = {
  name: "handoff_lead",
  description: "Mark a lead as handed off to a human agent. Logs the handoff event for audit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      reason: { type: "string" as const, description: "Reason for handoff" },
    },
    required: ["phone"],
  },
  execute: async (params: { phone: string; reason?: string }, context: HandoffLeadContext) => {
    const { db, labelService, runtime, agentNotifier } = context;
    const lead = await db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await db.updateLeadStatus(lead.id, "handed_off");
    await db.logHandoffEvent(
      lead.id,
      "manual_handoff",
      "tool",
      params.reason ? { reason: params.reason } : undefined,
    );

    // Apply HUMANO label
    try {
      await labelService.applyStatus(params.phone, "handed_off", runtime);
      console.log(`[handoff_lead] HUMANO label applied: ${params.phone}`);
    } catch (err) {
      console.error(`[handoff_lead] Failed to apply HUMANO label ${params.phone}:`, err);
    }

    // Notify agent numbers
    const updated = await db.getLeadById(lead.id);
    if (agentNotifier && updated) {
      try {
        await agentNotifier.notifyHandoff(updated, params.reason);
        console.log(`[handoff_lead] Agent notification sent for: ${params.phone}`);
      } catch (err) {
        console.error(`[handoff_lead] Failed to notify agents for ${params.phone}:`, err);
      }
    }

    return { success: true, lead: updated };
  },
};
