/**
 * Tool: get_followup_candidates
 *
 * Returns leads that are safe to contact for automated follow-up. All
 * eligibility gating happens in SQL — the caller iterates and sends without
 * any filtering, so it is impossible to contact a handed-off, blocked, or
 * already-exhausted lead through this tool.
 */

import type { Database } from "../database.js";

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
    context: { db: Database },
  ) => {
    const leads = await context.db.getFollowupCandidates(params);
    return { success: true, count: leads.length, leads };
  },
};
