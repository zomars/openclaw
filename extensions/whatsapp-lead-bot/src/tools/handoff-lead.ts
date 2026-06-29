/**
 * Tool: handoff_lead
 *
 * Marks a lead as handed off to a human agent, applies the HUMANO label,
 * and notifies configured agent numbers.
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import { appendResolvedLeadEvent } from "../crm-memory/lead-events.js";
import { resolveCrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { Runtime } from "../runtime.js";
import { normalizePhone } from "../utils/phone.js";

export interface HandoffLeadContext {
  db: Database;
  labelService: LabelService;
  runtime: Runtime;
  agentNotifier?: AgentNotifier;
  config?: WhatsAppLeadBotConfig;
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
    appendHandoffCrmEvent({
      db,
      config: context.config,
      phone: params.phone,
      lead: updated ?? lead,
      reason: params.reason,
    });
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

function appendHandoffCrmEvent(input: {
  db: Database;
  config?: WhatsAppLeadBotConfig;
  phone: string;
  lead: NonNullable<Awaited<ReturnType<Database["getLeadByPhone"]>>>;
  reason?: string;
}): void {
  const flags = resolveCrmMemoryRolloutFlags(input.config?.crmMemory);
  if (!flags.eventWritesEnabled) {
    return;
  }

  const leadPhone = normalizePhone(input.lead.phone_number || input.phone);
  if (!leadPhone) {
    return;
  }

  try {
    appendResolvedLeadEvent({
      scope: {
        leadKey: `whatsapp:${leadPhone}`,
        leadPhone,
      },
      log: input.db,
      event: {
        type: "tool.handoff_lead",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "handoff_lead",
        },
        summary: "Lead handed off to a human agent.",
        payload: {
          leadId: input.lead.id,
          reason: input.reason ?? null,
          status: input.lead.status,
          assignedAgent: input.lead.assigned_agent,
          handedOffAt: input.lead.handed_off_at,
        },
      },
    });
  } catch (err) {
    console.error(`[handoff_lead] Failed to append CRM memory event:`, err);
  }
}
