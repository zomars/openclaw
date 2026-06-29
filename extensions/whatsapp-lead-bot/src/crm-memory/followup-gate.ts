import type { LeadContext } from "./lead-context.js";
import { appendLeadEvent, type LeadEventLog } from "./lead-events.js";
import type { TrustedWhatsAppLeadScope } from "./lead-scope.js";

export type FollowupDecision =
  | {
      action: "skip";
      reason: "human_handoff_active";
      auditEventId: string;
    }
  | {
      action: "send";
      reason: "eligible";
      auditEventId: string;
    };

export function decideFollowupWithCrmContext(input: {
  scope: TrustedWhatsAppLeadScope;
  context: LeadContext;
  log: LeadEventLog;
  now?: () => number;
}): FollowupDecision {
  if (input.context.snapshot.locks.humanHandoff.active) {
    const event = appendLeadEvent({
      scope: input.scope,
      log: input.log,
      now: input.now,
      event: {
        type: "followup.skipped",
        actor: "cron",
        source: {
          channel: "system",
          toolName: "crm-memory-followup-gate",
        },
        summary: "Automated follow-up skipped because a human handoff lock is active.",
        payload: {
          reason: "human_handoff_active",
          assignedAgent: input.context.snapshot.locks.humanHandoff.assignedAgent,
        },
      },
    });
    return {
      action: "skip",
      reason: "human_handoff_active",
      auditEventId: event.id,
    };
  }

  const event = appendLeadEvent({
    scope: input.scope,
    log: input.log,
    now: input.now,
    event: {
      type: "followup.allowed",
      actor: "cron",
      source: {
        channel: "system",
        toolName: "crm-memory-followup-gate",
      },
      summary: "Automated follow-up allowed by CRM memory context.",
      payload: {
        reason: "eligible",
      },
    },
  });
  return {
    action: "send",
    reason: "eligible",
    auditEventId: event.id,
  };
}
