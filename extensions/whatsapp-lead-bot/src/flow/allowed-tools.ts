/**
 * Tool gating: which tools the LLM may invoke in each lead state.
 *
 * Enforced by the before_tool_call hook. A tool not present in the set for
 * the current state is blocked at the runtime boundary, so the LLM cannot
 * skip qualification steps even if the prompt fails to constrain it.
 */

import type { LeadState } from "./state.js";

/**
 * `null` means: this tool is always allowed regardless of state (utility
 * tools that don't drive customer-facing behavior). The intent of gating
 * is to bound *outbound* / state-changing actions, not introspection.
 */
const ALWAYS_ALLOWED = new Set<string>(["get_lead", "list_leads", "block_lead", "image", "media"]);

const PER_STATE: Record<LeadState, ReadonlySet<string>> = {
  NEW: new Set(["message", "save_lead"]),
  AWAITING_NAME: new Set(["message", "save_lead", "send_disqualification"]),
  AWAITING_LOCATION: new Set(["message", "save_lead", "send_disqualification"]),
  AWAITING_OWNERSHIP: new Set(["message", "save_lead", "send_disqualification"]),
  AWAITING_PROPERTY_TYPE: new Set(["message", "save_lead", "send_disqualification"]),
  AWAITING_BILL_AMOUNT: new Set(["message", "save_lead", "send_disqualification"]),
  AWAITING_RECEIPT: new Set([
    "message",
    "save_lead",
    "send_receipt_request",
    "send_disqualification",
    "process_cfe_receipt",
    "process_lead_cfe_receipt",
    "save_receipt_data",
  ]),
  READY_TO_QUOTE: new Set([
    "process_cfe_receipt",
    "process_lead_cfe_receipt",
    "message",
    "save_lead",
  ]),
  QUOTED: new Set(["message", "send_handoff_to_ale", "send_quote_url", "save_lead", "edit_quote"]),
  DISQUALIFIED: new Set([]),
  HANDED_OFF: new Set([]),
};

export function isToolAllowedInState(toolName: string, state: LeadState): boolean {
  if (ALWAYS_ALLOWED.has(toolName)) {
    return true;
  }
  return PER_STATE[state].has(toolName);
}

export function allowedToolsForState(state: LeadState): string[] {
  return [...ALWAYS_ALLOWED, ...PER_STATE[state]].toSorted();
}
