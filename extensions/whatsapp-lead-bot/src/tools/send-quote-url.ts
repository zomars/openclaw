import type { Database } from "../database.js";
import type { Lead } from "../database/schema.js";
import type { Runtime } from "../runtime.js";
import { normalizePhone } from "../utils/phone.js";

export interface SendQuoteUrlParams {
  phone: string;
  quoteNumber?: string;
}

export interface SendQuoteUrlContext {
  db: Database;
  runtime: Runtime;
  now?: () => number;
}

export interface SendQuoteUrlResult {
  success: boolean;
  error?: string;
  quoteNumber?: string;
  url?: string;
}

type SendQuoteUrlActor = "tool" | "admin";

interface SendQuoteUrlInput extends SendQuoteUrlParams {
  actor: SendQuoteUrlActor;
  source: string;
}

const inputSchema = {
  type: "object" as const,
  properties: {
    phone: { type: "string" as const, description: "Lead phone number (E.164 without +)" },
    quoteNumber: {
      type: "string" as const,
      description:
        "Optional quote folio to send. When omitted, sends the latest delivered active quote URL for the lead.",
    },
  },
  required: ["phone"],
};

export const sendQuoteUrlTool = {
  name: "send_quote_url",
  description:
    "Operator-triggered pilot action that sends the stored Lovable web quote URL to a selected lead. " +
    "It only sends an already-minted, non-expired quote access URL; it does not create quotes, mint tokens, or replace PDF default delivery.",
  inputSchema,
  execute: async (
    params: SendQuoteUrlParams,
    context: SendQuoteUrlContext,
  ): Promise<SendQuoteUrlResult> =>
    sendStoredQuoteUrl({ ...params, actor: "tool", source: "send_quote_url" }, context),
};

export async function sendStoredQuoteUrl(
  input: SendQuoteUrlInput,
  context: SendQuoteUrlContext,
): Promise<SendQuoteUrlResult> {
  const lead = await findLead(context.db, input.phone);
  if (!lead) {
    return { success: false, error: "Lead not found" };
  }

  const quoteAccess = await context.db.getLatestDeliveredQuoteAccess({
    customerPhones: phoneLookupCandidates(lead.phone_number),
    quoteNumber: input.quoteNumber ?? null,
    now: context.now?.() ?? Date.now(),
  });
  if (!quoteAccess) {
    return {
      success: false,
      error: input.quoteNumber
        ? `No active stored quote URL found for ${input.quoteNumber}`
        : "No active stored quote URL found for lead",
    };
  }

  await context.runtime.sendMessage(lead.phone_number, {
    text: quoteUrlMessage(quoteAccess.quote_access_url),
    metadata: {
      openclawInitiated: true,
      source: input.source,
      quoteNumber: quoteAccess.quote_number,
      quoteAccessTokenId: quoteAccess.quote_access_token_id,
      quoteAccessUrl: quoteAccess.quote_access_url,
      quoteAccessExpiresAt: quoteAccess.quote_access_expires_at,
      requestId: quoteAccess.request_id,
    },
  });
  await context.db.logHandoffEvent(lead.id, "quote_url_sent", input.actor, {
    quoteNumber: quoteAccess.quote_number,
    quoteAccessTokenId: quoteAccess.quote_access_token_id,
    quoteAccessExpiresAt: quoteAccess.quote_access_expires_at,
    requestId: quoteAccess.request_id,
  });
  await context.db.updateLastBotReply(lead.id, context.now?.() ?? Date.now());

  return {
    success: true,
    quoteNumber: quoteAccess.quote_number,
    url: quoteAccess.quote_access_url,
  };
}

function quoteUrlMessage(url: string): string {
  return [
    "Le comparto el enlace de su cotización:",
    url,
    "",
    "Puede revisarla desde su celular. Si necesita el PDF, también se lo podemos compartir.",
  ].join("\n");
}

async function findLead(db: Database, phone: string): Promise<Lead | null> {
  for (const candidate of phoneLookupCandidates(phone)) {
    const lead = await db.getLeadByPhone(candidate);
    if (lead) {
      return lead;
    }
  }
  return null;
}

function phoneLookupCandidates(phone: string): string[] {
  const digits = normalizePhone(phone);
  const candidates = [digits, `+${digits}`];
  if (digits.startsWith("52") && digits.length === 12) {
    candidates.push(`521${digits.slice(2)}`, `+521${digits.slice(2)}`);
  }
  if (digits.startsWith("521") && digits.length === 13) {
    candidates.push(`52${digits.slice(3)}`, `+52${digits.slice(3)}`);
  }
  return [...new Set(candidates)];
}
