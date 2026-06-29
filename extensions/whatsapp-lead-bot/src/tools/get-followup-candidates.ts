/**
 * Tool: get_followup_candidates
 *
 * Returns leads that are safe to contact for automated follow-up. All
 * eligibility gating happens in SQL — the caller iterates and sends without
 * any filtering, so it is impossible to contact a handed-off, blocked, or
 * already-exhausted lead through this tool.
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import { appendResolvedLeadEvent } from "../crm-memory/lead-events.js";
import { deriveLeadSnapshot } from "../crm-memory/lead-snapshot.js";
import { resolveCrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { Database } from "../database.js";
import type { Lead } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";

export const getFollowupCandidatesTool = {
  name: "get_followup_candidates",
  description:
    "Return leads eligible for automated follow-up. All filtering (handoff, block, rate-limit, idle window, attempt cap) runs in SQL — every returned lead is safe to message. Defaults to HOT/WARM × new/qualifying, idle 3+ days, attempts < 3, max 5 results, oldest first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scores: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Allowed scores. Default: ['HOT','WARM'].",
      },
      statuses: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Allowed statuses. Default: ['new','qualifying'].",
      },
      limit: {
        type: "number" as const,
        description: "Maximum candidates to return. Default: 5.",
      },
      minIdleMs: {
        type: "number" as const,
        description: "Minimum idle time since last_message_at, in ms. Default: 259200000 (3 days).",
      },
      maxAttempts: {
        type: "number" as const,
        description: "Skip leads whose follow_up_attempts >= maxAttempts. Default: 3.",
      },
    },
    required: [] as string[],
  },
  execute: async (
    params: {
      scores?: string[];
      statuses?: string[];
      limit?: number;
      minIdleMs?: number;
      maxAttempts?: number;
    },
    context: { db: Database; config?: WhatsAppLeadBotConfig },
  ) => {
    const leads = await context.db.getFollowupCandidates(params);
    const gatedLeads = applyCrmMemoryFollowupGate({
      db: context.db,
      config: context.config,
      leads,
    });
    return { success: true, count: gatedLeads.length, leads: gatedLeads };
  },
};

function applyCrmMemoryFollowupGate(input: {
  db: Database;
  config?: WhatsAppLeadBotConfig;
  leads: Lead[];
}): Lead[] {
  const flags = resolveCrmMemoryRolloutFlags(input.config?.crmMemory);
  if (!flags.cronGateEnabled) {
    return input.leads;
  }

  return input.leads.filter((lead) => {
    const leadPhone = normalizePhone(lead.phone_number);
    if (!leadPhone) {
      return true;
    }
    const leadKey = `whatsapp:${leadPhone}`;
    const snapshot = deriveLeadSnapshot({
      lead,
      events: input.db.read(leadKey),
    });

    if (!snapshot.locks.humanHandoff.active) {
      return true;
    }

    if (flags.eventWritesEnabled) {
      try {
        appendResolvedLeadEvent({
          scope: {
            leadKey,
            leadPhone,
          },
          log: input.db,
          event: {
            type: "followup.skipped",
            actor: "cron",
            source: {
              channel: "tool",
              toolName: "get_followup_candidates",
            },
            summary: "Automated follow-up candidate skipped by CRM memory context.",
            payload: {
              leadId: lead.id,
              reason: "human_handoff_active",
              assignedAgent: snapshot.locks.humanHandoff.assignedAgent,
            },
          },
        });
      } catch (err) {
        console.error(`[get_followup_candidates] Failed to append CRM skip event:`, err);
      }
    }

    return false;
  });
}
