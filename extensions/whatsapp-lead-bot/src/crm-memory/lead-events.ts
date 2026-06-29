import type { TrustedWhatsAppLeadScope } from "./lead-scope.js";

export type LeadEventActor = "prospect" | "bot" | "admin" | "cron" | "tool" | "system";

export type LeadEventSource = {
  channel: "whatsapp" | string;
  messageId?: string;
  toolName?: string;
  accountId?: string;
  agentId?: string;
  conversationId?: string;
};

export type LeadEventDraft = {
  type: string;
  actor: LeadEventActor;
  source: LeadEventSource;
  summary: string;
  payload?: unknown;
};

export type LeadEventRecord = LeadEventDraft & {
  id: string;
  leadKey: string;
  leadPhone: string;
  timestamp: number;
  source: LeadEventSource;
};

export type LeadEventRejectedWrite = {
  attemptedEventId: string;
  attemptedLeadKey: string;
  attemptedLeadPhone: string;
  scopedLeadKey: string;
  reason: "cross_lead_event_write";
  source: LeadEventSource;
  summary: string;
};

export type LeadEventLog = {
  append(leadKey: string, event: LeadEventRecord): void;
  read(leadKey: string): LeadEventRecord[];
};

export type AppendLeadEventInput = {
  scope: TrustedWhatsAppLeadScope;
  log: LeadEventLog;
  event: LeadEventDraft;
  now?: () => number;
};

export type ResolvedLeadEventScope = {
  leadKey: string;
  leadPhone: string;
  audit?: {
    accountId?: string;
    agentId?: string;
    conversationId?: string;
  };
};

export type AppendResolvedLeadEventInput = {
  scope: ResolvedLeadEventScope;
  log: LeadEventLog;
  event: LeadEventDraft;
  now?: () => number;
};

export class InMemoryLeadEventLog implements LeadEventLog {
  private readonly eventsByLead = new Map<string, LeadEventRecord[]>();
  private readonly rejectedWrites: LeadEventRejectedWrite[] = [];

  append(leadKey: string, event: LeadEventRecord): void {
    if (!eventMatchesLeadKey(leadKey, event)) {
      this.rejectedWrites.push({
        attemptedEventId: event.id,
        attemptedLeadKey: event.leadKey,
        attemptedLeadPhone: event.leadPhone,
        scopedLeadKey: leadKey,
        reason: "cross_lead_event_write",
        source: event.source,
        summary: event.summary,
      });
      throw new Error(
        `Cross-lead event write rejected: scoped lead ${leadKey} cannot receive event for ${event.leadKey}`,
      );
    }

    const current = this.eventsByLead.get(leadKey) ?? [];
    this.eventsByLead.set(leadKey, [...current, event]);
  }

  read(leadKey: string): LeadEventRecord[] {
    return [...(this.eventsByLead.get(leadKey) ?? [])];
  }

  readRejectedWrites(): LeadEventRejectedWrite[] {
    return [...this.rejectedWrites];
  }
}

export function appendLeadEvent(input: AppendLeadEventInput): LeadEventRecord {
  if (!input.scope.ok) {
    throw new Error(`Cannot append lead event without trusted scope: ${input.scope.reason}`);
  }

  const timestamp = input.now?.() ?? Date.now();
  const existingEvents = input.log.read(input.scope.scope.leadKey);
  const event: LeadEventRecord = {
    id: buildEventId({
      timestamp,
      leadPhone: input.scope.scope.leadPhone,
      sequence: existingEvents.length + 1,
    }),
    leadKey: input.scope.scope.leadKey,
    leadPhone: input.scope.scope.leadPhone,
    type: input.event.type,
    actor: input.event.actor,
    timestamp,
    source: {
      ...input.event.source,
      accountId: input.scope.scope.audit.accountId,
      agentId: input.scope.scope.audit.agentId,
      conversationId: input.scope.scope.audit.conversationId,
    },
    summary: input.event.summary,
    payload: input.event.payload,
  };

  input.log.append(input.scope.scope.leadKey, event);
  return event;
}

export function appendResolvedLeadEvent(input: AppendResolvedLeadEventInput): LeadEventRecord {
  const timestamp = input.now?.() ?? Date.now();
  const existingEvents = input.log.read(input.scope.leadKey);
  const event: LeadEventRecord = {
    id: buildEventId({
      timestamp,
      leadPhone: input.scope.leadPhone,
      sequence: existingEvents.length + 1,
    }),
    leadKey: input.scope.leadKey,
    leadPhone: input.scope.leadPhone,
    type: input.event.type,
    actor: input.event.actor,
    timestamp,
    source: {
      ...input.event.source,
      accountId: input.scope.audit?.accountId,
      agentId: input.scope.audit?.agentId,
      conversationId: input.scope.audit?.conversationId,
    },
    summary: input.event.summary,
    payload: input.event.payload,
  };

  input.log.append(input.scope.leadKey, event);
  return event;
}

function buildEventId(input: { timestamp: number; leadPhone: string; sequence: number }): string {
  return `evt-${input.timestamp}-whatsapp-${input.leadPhone}-${input.sequence}`;
}

export function eventMatchesLeadKey(leadKey: string, event: LeadEventRecord): boolean {
  return event.leadKey === leadKey && leadKey === `whatsapp:${event.leadPhone}`;
}
