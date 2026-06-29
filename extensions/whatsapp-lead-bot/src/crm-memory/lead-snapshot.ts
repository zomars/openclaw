import type { Lead } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";
import type { LeadEventRecord } from "./lead-events.js";

export type LeadSnapshotSource =
  | {
      type: "leads.db";
      leadId: number;
      field: string;
      sourceUpdatedAt: number | null;
    }
  | {
      type: "lead_event";
      eventId: string;
      eventType: string;
      timestamp: number;
      field: string;
    };

export type ProvenancedValue<T> = {
  value: T;
  source: LeadSnapshotSource;
};

export type LeadSnapshotConflict = {
  field: string;
  current: unknown;
  incoming: unknown;
  currentSource: LeadSnapshotSource;
  incomingSource: LeadSnapshotSource;
  reason: "conflicting_fact";
};

export type LeadSnapshotFact = {
  key: string;
  value: unknown;
  confidence: "confirmed" | "inferred";
  source: LeadSnapshotSource;
};

export type LeadSnapshotArtifact = {
  id: string;
  type: string;
  pointer: string;
  checksum?: string;
  source: LeadSnapshotSource;
};

export type LeadSnapshotTimelineItem = {
  id: string;
  type: string;
  actor: LeadEventRecord["actor"];
  timestamp: number;
  summary: string;
};

export type LeadSnapshot = {
  profile: {
    id: ProvenancedValue<number>;
    phoneNumber: ProvenancedValue<string>;
    name: ProvenancedValue<string | null>;
    status: ProvenancedValue<string>;
    score: ProvenancedValue<string | null>;
    location: ProvenancedValue<string | null>;
    ownership: ProvenancedValue<string | null>;
    bimonthlyBill: ProvenancedValue<number | null>;
    intent?: ProvenancedValue<string>;
  };
  facts: LeadSnapshotFact[];
  artifacts: LeadSnapshotArtifact[];
  locks: {
    humanHandoff: {
      active: boolean;
      assignedAgent: string | null;
      source: LeadSnapshotSource;
    };
  };
  timeline: LeadSnapshotTimelineItem[];
  conflicts: LeadSnapshotConflict[];
  source: {
    type: "derived_crm_memory";
    leadId: number;
    eventCount: number;
  };
};

const DERIVED_PROFILE_FIELDS = new Set(["location", "ownership", "bimonthlyBill", "intent"]);

export function deriveLeadSnapshot(input: { lead: Lead; events: LeadEventRecord[] }): LeadSnapshot {
  const lead = input.lead;
  const db = (field: string): LeadSnapshotSource => ({
    type: "leads.db",
    leadId: lead.id,
    field,
    sourceUpdatedAt: lead.updated_at,
  });

  const profile: LeadSnapshot["profile"] = {
    id: { value: lead.id, source: db("id") },
    phoneNumber: { value: normalizePhone(lead.phone_number), source: db("phone_number") },
    name: { value: lead.name, source: db("name") },
    status: { value: lead.status, source: db("status") },
    score: { value: lead.score, source: db("score") },
    location: { value: lead.location, source: db("location") },
    ownership: { value: lead.ownership, source: db("ownership") },
    bimonthlyBill: { value: lead.bimonthly_bill, source: db("bimonthly_bill") },
  };

  const facts: LeadSnapshotFact[] = [];
  const artifacts: LeadSnapshotArtifact[] = [];
  const conflicts: LeadSnapshotConflict[] = [];
  let humanHandoff = {
    active: Boolean(lead.handed_off_at || lead.assigned_agent),
    assignedAgent: lead.assigned_agent,
    source: db("handoff"),
  };

  const sortedEvents = [...input.events].sort((a, b) => a.timestamp - b.timestamp);
  for (const event of sortedEvents) {
    const payload = asRecord(event.payload);
    const source = (field: string): LeadSnapshotSource => ({
      type: "lead_event",
      eventId: event.id,
      eventType: event.type,
      timestamp: event.timestamp,
      field,
    });

    if (event.type === "fact.updated") {
      const field = stringValue(payload.field ?? payload.fact);
      if (field && DERIVED_PROFILE_FIELDS.has(field) && "value" in payload) {
        applyProfileFact({
          profile,
          conflicts,
          field,
          value: payload.value,
          source: source(field),
        });
      }
      if (field && "value" in payload) {
        facts.push({
          key: field,
          value: payload.value,
          confidence: payload.confidence === "inferred" ? "inferred" : "confirmed",
          source: source(field),
        });
      }
    }

    if (event.type === "receipt.received") {
      if ("bimonthlyBill" in payload) {
        applyProfileFact({
          profile,
          conflicts,
          field: "bimonthlyBill",
          value: payload.bimonthlyBill,
          source: source("bimonthlyBill"),
        });
        facts.push({
          key: "bimonthlyBill",
          value: payload.bimonthlyBill,
          confidence: "confirmed",
          source: source("bimonthlyBill"),
        });
      }
      registerArtifactFromPayload(artifacts, event, source("artifact"), payload);
    }

    if (event.type === "quote.sent") {
      registerArtifactFromPayload(artifacts, event, source("artifact"), payload);
      facts.push({
        key: "quoteSent",
        value: true,
        confidence: "confirmed",
        source: source("quoteSent"),
      });
    }

    if (event.type === "handoff.started") {
      humanHandoff = {
        active: true,
        assignedAgent: stringValue(payload.assignedAgent) ?? "human",
        source: source("handoff"),
      };
      facts.push({
        key: "humanHandoff",
        value: true,
        confidence: "confirmed",
        source: source("handoff"),
      });
    }
  }

  return {
    profile,
    facts,
    artifacts,
    locks: {
      humanHandoff,
    },
    timeline: sortedEvents.map((event) => ({
      id: event.id,
      type: event.type,
      actor: event.actor,
      timestamp: event.timestamp,
      summary: event.summary,
    })),
    conflicts,
    source: {
      type: "derived_crm_memory",
      leadId: lead.id,
      eventCount: sortedEvents.length,
    },
  };
}

function applyProfileFact(input: {
  profile: LeadSnapshot["profile"];
  conflicts: LeadSnapshotConflict[];
  field: "location" | "ownership" | "bimonthlyBill" | "intent" | string;
  value: unknown;
  source: LeadSnapshotSource;
}): void {
  if (input.field === "intent") {
    if (typeof input.value === "string" && input.value.length > 0) {
      input.profile.intent = { value: input.value, source: input.source };
    }
    return;
  }

  const key = input.field as "location" | "ownership" | "bimonthlyBill";
  const current = input.profile[key];
  if (!current) {
    return;
  }

  if (current.value == null || current.value === "") {
    (input.profile[key] as ProvenancedValue<unknown>) = {
      value: input.value,
      source: input.source,
    };
    return;
  }

  if (input.value != null && current.value !== input.value) {
    input.conflicts.push({
      field: input.field,
      current: current.value,
      incoming: input.value,
      currentSource: current.source,
      incomingSource: input.source,
      reason: "conflicting_fact",
    });
  }
}

function registerArtifactFromPayload(
  artifacts: LeadSnapshotArtifact[],
  event: LeadEventRecord,
  source: LeadSnapshotSource,
  payload: Record<string, unknown>,
): void {
  const artifact = asRecord(payload.artifact);
  if (!artifact) {
    return;
  }

  const id = stringValue(artifact.id) ?? `artifact-${event.id}`;
  const type = stringValue(artifact.type);
  const pointer = stringValue(artifact.pointer);
  if (!type || !pointer) {
    return;
  }

  artifacts.push({
    id,
    type,
    pointer,
    checksum: stringValue(artifact.checksum),
    source,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
