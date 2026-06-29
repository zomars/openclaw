/**
 * Tool: block_lead
 *
 * Blocks a lead from further bot interaction.
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import { appendResolvedLeadEvent } from "../crm-memory/lead-events.js";
import { resolveCrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { Database } from "../database.js";
import { normalizePhone } from "../utils/phone.js";

export const blockLeadTool = {
  name: "block_lead",
  description: "Block a lead from further bot interaction.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      reason: { type: "string" as const, description: "Reason for blocking" },
    },
    required: ["phone"],
  },
  execute: async (
    params: { phone: string; reason?: string },
    context: { db: Database; config?: WhatsAppLeadBotConfig },
  ) => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.db.blockLead(lead.id, params.reason || "Blocked via tool");

    const updated = await context.db.getLeadById(lead.id);
    appendBlockCrmEvent({
      db: context.db,
      config: context.config,
      phone: params.phone,
      lead: updated ?? lead,
      reason: params.reason || "Blocked via tool",
    });
    return { success: true, lead: updated };
  },
};

function appendBlockCrmEvent(input: {
  db: Database;
  config?: WhatsAppLeadBotConfig;
  phone: string;
  lead: NonNullable<Awaited<ReturnType<Database["getLeadByPhone"]>>>;
  reason: string;
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
        type: "tool.block_lead",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "block_lead",
        },
        summary: "Lead blocked from bot interaction.",
        payload: {
          leadId: input.lead.id,
          reason: input.reason,
          status: input.lead.status,
          blockedAt: input.lead.blocked_at,
          blockedReason: input.lead.blocked_reason,
        },
      },
    });
  } catch (err) {
    console.error(`[block_lead] Failed to append CRM memory event:`, err);
  }
}
