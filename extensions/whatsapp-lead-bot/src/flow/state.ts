/**
 * Deterministic lead state machine.
 *
 * Given a Lead row, compute the single state that describes what the agent
 * should do next. The agent never decides this — the state is derived from
 * data, so the LLM cannot skip steps.
 */

import type { Lead } from "../database/schema.js";

export const LEAD_STATES = [
  "NEW",
  "AWAITING_NAME",
  "AWAITING_LOCATION",
  "AWAITING_OWNERSHIP",
  "AWAITING_PROPERTY_TYPE",
  "AWAITING_BILL_AMOUNT",
  "AWAITING_RECEIPT",
  "READY_TO_QUOTE",
  "QUOTED",
  "DISQUALIFIED",
  "HANDED_OFF",
] as const;

export type LeadState = (typeof LEAD_STATES)[number];

export const SINALOA_KEYWORDS = [
  "sinaloa",
  "culiacan",
  "culiacán",
  "mazatlan",
  "mazatlán",
  "los mochis",
  "guasave",
  "guamuchil",
  "guamúchil",
  "navolato",
  "el fuerte",
  "ahome",
  "elota",
  "san ignacio",
  "rosario",
  "escuinapa",
  "concordia",
  "cosalá",
  "cosala",
  "badiraguato",
  "salvador alvarado",
  "angostura",
  "mocorito",
  "sinaloa de leyva",
  "choix",
];

export function isSinaloaLocation(location: string): boolean {
  const normalized = location.toLowerCase().trim();
  return SINALOA_KEYWORDS.some((kw) => normalized.includes(kw));
}

export function isOwner(ownership: string): boolean {
  const o = ownership.toLowerCase().trim();
  return o === "propia" || o === "propietario" || o === "owner" || o === "dueño" || o === "dueno";
}

export interface LeadFieldsForState {
  status: Lead["status"];
  name: string | null;
  location: string | null;
  ownership: string | null;
  property_type: string | null;
  bimonthly_bill: number | null;
  bill_id: string | null;
  panels_quoted: number | null;
}

/**
 * Compute the current state purely from persisted lead data.
 * Order of evaluation matters: terminal states first, then linear progression.
 */
export function computeLeadState(lead: LeadFieldsForState): LeadState {
  // Terminal: handed off
  if (lead.status === "handed_off") {
    return "HANDED_OFF";
  }

  // Terminal: ignored = disqualified for our purposes
  if (lead.status === "ignored" || lead.status === "blocked") {
    return "DISQUALIFIED";
  }

  // Disqualifying conditions evaluated against present data
  if (lead.location && !isSinaloaLocation(lead.location)) {
    return "DISQUALIFIED";
  }
  if (lead.ownership && !isOwner(lead.ownership)) {
    return "DISQUALIFIED";
  }
  if (
    typeof lead.bimonthly_bill === "number" &&
    lead.bimonthly_bill > 0 &&
    lead.bimonthly_bill < 500
  ) {
    return "DISQUALIFIED";
  }

  // Quoted: panels_quoted set means a quote has been delivered
  if (typeof lead.panels_quoted === "number" && lead.panels_quoted > 0) {
    return "QUOTED";
  }

  // Receipt parsed → ready to quote
  if (lead.bill_id) {
    return "READY_TO_QUOTE";
  }

  // Linear qualification flow
  if (!lead.name) {
    return "AWAITING_NAME";
  }
  if (!lead.location) {
    return "AWAITING_LOCATION";
  }
  if (!lead.ownership) {
    return "AWAITING_OWNERSHIP";
  }
  if (!lead.property_type) {
    return "AWAITING_PROPERTY_TYPE";
  }
  if (typeof lead.bimonthly_bill !== "number" || lead.bimonthly_bill <= 0) {
    return "AWAITING_BILL_AMOUNT";
  }
  return "AWAITING_RECEIPT";
}

/** Convenience: extract the fields used for state computation from a Lead row. */
export function leadStateInputFromRow(row: {
  status: Lead["status"];
  name: string | null;
  location: string | null;
  ownership: string | null;
  property_type: string | null;
  bimonthly_bill: number | null;
  panels_quoted: number | null;
  receipt_data: string | null;
}): LeadFieldsForState {
  let billId: string | null = null;
  if (row.receipt_data) {
    try {
      const parsed = JSON.parse(row.receipt_data) as Record<string, unknown>;
      const candidate = parsed.bill_id ?? parsed.billId;
      if (typeof candidate === "string" && candidate.length > 0) {
        billId = candidate;
      }
    } catch {
      // ignore — receipt_data may be partial / non-JSON
    }
  }
  return {
    status: row.status,
    name: row.name,
    location: row.location,
    ownership: row.ownership,
    property_type: row.property_type,
    bimonthly_bill: row.bimonthly_bill,
    bill_id: billId,
    panels_quoted: row.panels_quoted,
  };
}
