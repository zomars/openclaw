import type { Lead } from "../database/schema.js";

export interface LovableLeadPayload {
  phone_number: string;
  name?: string | null;
  status?: string | null;
  score?: string | null;
  location?: string | null;
  property_type?: string | null;
  ownership?: string | null;
  bimonthly_bill?: number | null;
  tariff?: string | null;
  annual_kwh?: number | null;
  notes?: string | null;
  assigned_to_phone?: string | null;
  source: "openclaw_whatsapp";
  panels_quoted?: number | null;
  quote_cash?: number | null;
  quote_financed?: number | null;
  last_message_at?: string | null;
  openclaw_lead_id?: string;
  last_openclaw_message_id?: string | null;
  last_message_preview?: string | null;
  last_message_direction?: "inbound" | "outbound" | null;
}

export interface RemoteLovableLead {
  id: string;
  phone_number: string;
  status?: string | null;
  assigned_to_phone?: string | null;
  handoff_reason?: string | null;
  updated_at?: string | null;
}

export interface ListLovableLeadsResult {
  leads: RemoteLovableLead[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface LovableCrmClient {
  saveLead(payload: LovableLeadPayload): Promise<void>;
  listLeads(input: {
    cursor?: string | null;
    updatedAfter?: string | null;
    limit: number;
  }): Promise<ListLovableLeadsResult>;
}

export function createLovableCrmClient(input: {
  apiKey: string;
  saveLeadUrl: string;
  listLeadsUrl: string;
}): LovableCrmClient {
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": input.apiKey,
  };

  return {
    async saveLead(payload) {
      const response = await fetch(input.saveLeadUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`save-lead HTTP ${response.status}: ${await response.text()}`);
      }
    },

    async listLeads(params) {
      const url = new URL(input.listLeadsUrl);
      url.searchParams.set("limit", String(params.limit));
      if (params.cursor) {
        url.searchParams.set("cursor", params.cursor);
      } else if (params.updatedAfter) {
        url.searchParams.set("updated_after", params.updatedAfter);
      }

      const response = await fetch(url, { method: "GET", headers });
      if (!response.ok) {
        throw new Error(`list-leads HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as ListLovableLeadsResult;
    },
  };
}

export function leadMillisToIso(value: number | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString();
}

export function buildLeadSnapshotPayload(
  lead: Lead,
  lastMessage?: {
    id: string;
    content: string | null;
    from_me: number;
  } | null,
): LovableLeadPayload {
  return {
    phone_number: lead.phone_number,
    name: lead.name,
    status: lead.status,
    score: lead.score,
    location: lead.location,
    property_type: lead.property_type,
    ownership: lead.ownership,
    bimonthly_bill: lead.bimonthly_bill,
    tariff: lead.tariff,
    annual_kwh: lead.annual_kwh,
    notes: lead.notes,
    assigned_to_phone: lead.assigned_agent,
    source: "openclaw_whatsapp",
    panels_quoted: lead.panels_quoted,
    quote_cash: lead.quote_cash,
    quote_financed: lead.quote_financed,
    last_message_at: leadMillisToIso(lead.last_message_at),
    openclaw_lead_id: String(lead.id),
    last_openclaw_message_id: lastMessage?.id ?? null,
    last_message_preview: previewMessage(lastMessage?.content ?? null),
    last_message_direction: lastMessage ? (lastMessage.from_me ? "outbound" : "inbound") : null,
  };
}

function previewMessage(content: string | null): string | null {
  if (!content) {
    return null;
  }
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}
