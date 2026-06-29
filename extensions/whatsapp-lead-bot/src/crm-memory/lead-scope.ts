import type { PluginHookMessageContext, PluginHookMessageReceivedEvent } from "../types.js";
import { normalizePhone } from "../utils/phone.js";

export type TrustedWhatsAppLeadScopeInput = {
  event: PluginHookMessageReceivedEvent;
  ctx: PluginHookMessageContext;
};

export type TrustedWhatsAppLeadScope =
  | {
      ok: true;
      scope: {
        leadPhone: string;
        leadKey: string;
        source: "event.from" | "metadata.senderE164";
        audit: {
          accountId?: string;
          agentId?: string;
          conversationId?: string;
          messageId?: string;
          ctwaClid?: string;
        };
      };
    }
  | {
      ok: false;
      reason: "not_whatsapp" | "owner_message" | "group_or_ambiguous" | "missing_trusted_sender";
    };

export function resolveTrustedWhatsAppLeadScope(
  input: TrustedWhatsAppLeadScopeInput,
): TrustedWhatsAppLeadScope {
  const metadata = input.event.metadata ?? {};

  if (
    input.ctx.channelId !== "whatsapp" ||
    (metadata.originatingChannel !== undefined && metadata.originatingChannel !== "whatsapp")
  ) {
    return { ok: false, reason: "not_whatsapp" };
  }

  if (metadata.sentByAccountOwner === true) {
    return { ok: false, reason: "owner_message" };
  }

  const from = input.event.from;
  if (isGroupOrAmbiguousWhatsAppIdentity(from)) {
    return { ok: false, reason: "group_or_ambiguous" };
  }

  const trustedSender = firstString(from, metadata.senderE164);
  if (!trustedSender) {
    return { ok: false, reason: "missing_trusted_sender" };
  }

  const leadPhone = normalizePhone(stripWhatsAppAddress(trustedSender));
  if (!leadPhone) {
    return { ok: false, reason: "missing_trusted_sender" };
  }

  return {
    ok: true,
    scope: {
      leadPhone,
      leadKey: `whatsapp:${leadPhone}`,
      source: from ? "event.from" : "metadata.senderE164",
      audit: {
        accountId: input.ctx.accountId,
        agentId: input.ctx.agentId,
        conversationId: input.ctx.conversationId,
        messageId: firstString(metadata.messageId),
        ctwaClid: firstString(metadata.ctwaClid),
      },
    },
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stripWhatsAppAddress(sender: string): string {
  return sender.split("@", 1)[0] ?? sender;
}

function isGroupOrAmbiguousWhatsAppIdentity(value: string): boolean {
  return value.includes("@g.us");
}
