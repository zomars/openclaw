import { normalizePhone } from "../utils/phone.js";

export interface TrustedWhatsAppScopeMetadata {
  channelId: "whatsapp" | string;
  accountId?: string;
  conversationId?: string;
  from?: string;
  senderPhone?: string;
}

export interface ResolveLeadScopeInput {
  runtime: TrustedWhatsAppScopeMetadata;
  messageText?: string;
}

export interface ResolvedLeadScope {
  channelId: "whatsapp";
  accountId?: string;
  conversationId?: string;
  leadPhone: string;
  leadKey: string;
  source: "runtime.from" | "runtime.senderPhone";
}

export type LeadScopeResolution =
  | { ok: true; scope: ResolvedLeadScope }
  | { ok: false; reason: "unsupported_channel" | "missing_trusted_sender" };

/**
 * PROTOTYPE US-001: resolve the current lead only from trusted runtime scope.
 * messageText is intentionally accepted but ignored to prove body mentions
 * cannot change the selected lead.
 */
export function resolveCurrentLeadScope(input: ResolveLeadScopeInput): LeadScopeResolution {
  const { runtime } = input;

  if (runtime.channelId !== "whatsapp") {
    return { ok: false, reason: "unsupported_channel" };
  }

  const sender = runtime.from ?? runtime.senderPhone;
  if (!sender) {
    return { ok: false, reason: "missing_trusted_sender" };
  }

  const leadPhone = normalizePhone(stripWhatsAppAddress(sender));
  if (!leadPhone) {
    return { ok: false, reason: "missing_trusted_sender" };
  }

  return {
    ok: true,
    scope: {
      channelId: "whatsapp",
      accountId: runtime.accountId,
      conversationId: runtime.conversationId,
      leadPhone,
      leadKey: `whatsapp:${leadPhone}`,
      source: runtime.from ? "runtime.from" : "runtime.senderPhone",
    },
  };
}

function stripWhatsAppAddress(sender: string): string {
  return sender.split("@", 1)[0] ?? sender;
}
