import type { Lead } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";
import type { LeadEventLog } from "./lead-events.js";
import type { TrustedWhatsAppLeadScope } from "./lead-scope.js";
import { deriveLeadSnapshot, type LeadSnapshot } from "./lead-snapshot.js";

export type LeadContext = {
  leadKey: string;
  leadPhone: string;
  snapshot: LeadSnapshot;
  nextActionHints: string[];
};

export function readLeadContext(input: {
  scope: TrustedWhatsAppLeadScope;
  lead: Lead;
  log: LeadEventLog;
}): LeadContext {
  if (!input.scope.ok) {
    throw new Error(`Cannot read lead context without trusted scope: ${input.scope.reason}`);
  }

  const leadPhone = normalizePhone(input.lead.phone_number);
  if (leadPhone !== input.scope.scope.leadPhone) {
    throw new Error(
      `Scoped lead mismatch: ${input.scope.scope.leadPhone} cannot read ${leadPhone}`,
    );
  }

  const events = input.log.read(input.scope.scope.leadKey);
  const snapshot = deriveLeadSnapshot({ lead: input.lead, events });

  return {
    leadKey: input.scope.scope.leadKey,
    leadPhone: input.scope.scope.leadPhone,
    snapshot,
    nextActionHints: deriveNextActionHints(snapshot),
  };
}

function deriveNextActionHints(snapshot: LeadSnapshot): string[] {
  if (snapshot.locks.humanHandoff.active) {
    return ["human_handoff_active"];
  }
  if (snapshot.profile.intent?.value === "quote") {
    return ["continue_quote_flow"];
  }
  if (snapshot.artifacts.some((artifact) => artifact.type === "cfe_receipt")) {
    return ["review_receipt_and_quote"];
  }
  return ["ask_next_qualification_question"];
}
