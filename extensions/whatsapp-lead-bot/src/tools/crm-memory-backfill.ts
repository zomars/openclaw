import { appendResolvedLeadEvent, type LeadEventDraft } from "../crm-memory/lead-events.js";
import type { Database } from "../database.js";
import type { Lead } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";

export const crmMemoryBackfillTool = {
  name: "crm_memory_backfill",
  description:
    "Backfill durable CRM memory events from existing local leads, receipts, quotes, handoffs, blocks, and message history.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number" as const,
        description: "Optional maximum number of leads to backfill.",
      },
      dryRun: {
        type: "boolean" as const,
        description: "Count planned events without writing them.",
      },
    },
    required: [] as string[],
  },
  execute: async (
    params: { limit?: number; dryRun?: boolean },
    context: { db: Database; now?: () => number },
  ) => {
    const leads = await context.db.listLeads({});
    const selected = typeof params.limit === "number" ? leads.slice(0, params.limit) : leads;
    let inspected = 0;
    let written = 0;
    let planned = 0;
    let skipped = 0;

    for (const lead of selected) {
      inspected += 1;
      const result = backfillLead({
        db: context.db,
        lead,
        dryRun: params.dryRun === true,
        now: context.now,
      });
      written += result.written;
      planned += result.planned;
      skipped += result.skipped;
    }

    return {
      success: true,
      inspected,
      planned,
      written,
      skipped,
      dryRun: params.dryRun === true,
    };
  },
};

function backfillLead(input: { db: Database; lead: Lead; dryRun: boolean; now?: () => number }): {
  planned: number;
  written: number;
  skipped: number;
} {
  const leadPhone = normalizePhone(input.lead.phone_number);
  if (!leadPhone) {
    return { planned: 0, written: 0, skipped: 1 };
  }

  const leadKey = `whatsapp:${leadPhone}`;
  const existingTypes = new Set(input.db.read(leadKey).map((event) => event.type));
  const drafts = buildBackfillDrafts(input.db, input.lead, leadPhone);
  let planned = 0;
  let written = 0;
  let skipped = 0;

  for (const draft of drafts) {
    if (existingTypes.has(draft.type)) {
      skipped += 1;
      continue;
    }
    planned += 1;
    if (input.dryRun) {
      continue;
    }
    appendResolvedLeadEvent({
      scope: { leadKey, leadPhone },
      log: input.db,
      now: input.now,
      event: draft,
    });
    existingTypes.add(draft.type);
    written += 1;
  }

  return { planned, written, skipped };
}

function buildBackfillDrafts(db: Database, lead: Lead, leadPhone: string): LeadEventDraft[] {
  const drafts: LeadEventDraft[] = [
    {
      type: "lead.backfilled",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing lead imported into CRM memory.",
      payload: {
        leadId: lead.id,
        status: lead.status,
        score: lead.score,
        name: lead.name,
        location: lead.location,
        ownership: lead.ownership,
        bimonthlyBill: lead.bimonthly_bill,
        createdAt: lead.created_at,
        updatedAt: lead.updated_at,
      },
    },
  ];

  const messages = db.getMessagesByPeerE164Sync(leadPhone, 200);
  if (messages.length > 0) {
    const latest = db.getLatestMessageByPeerE164Sync(leadPhone) ?? messages.at(-1)!;
    drafts.push({
      type: "messages.backfilled",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing WhatsApp message history linked to CRM memory.",
      payload: {
        leadId: lead.id,
        messageCount: messages.length,
        latestMessageId: latest.id,
        latestMessageAt: latest.timestamp,
        latestMessageFromMe: latest.from_me === 1,
      },
    });
  }

  if (lead.receipt_data || lead.tariff || lead.annual_kwh !== null) {
    drafts.push({
      type: "receipt.received",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing CFE receipt data imported into CRM memory.",
      payload: {
        leadId: lead.id,
        tariff: lead.tariff,
        annualKwh: lead.annual_kwh,
        receiptDataLength: lead.receipt_data?.length ?? 0,
      },
    });
  }

  if (
    lead.panels_quoted !== null ||
    lead.quote_cash !== null ||
    lead.quote_financed !== null ||
    lead.quoted_at !== null
  ) {
    drafts.push({
      type: "quote.sent",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing quote data imported into CRM memory.",
      payload: {
        leadId: lead.id,
        panelsQuoted: lead.panels_quoted,
        quoteCash: lead.quote_cash,
        quoteFinanced: lead.quote_financed,
        quotedAt: lead.quoted_at,
      },
    });
  }

  if (lead.handed_off_at || lead.assigned_agent || lead.status === "handed_off") {
    drafts.push({
      type: "handoff.started",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing human handoff imported into CRM memory.",
      payload: {
        leadId: lead.id,
        assignedAgent: lead.assigned_agent,
        handedOffAt: lead.handed_off_at,
        status: lead.status,
      },
    });
  }

  if (lead.blocked_at || lead.status === "blocked") {
    drafts.push({
      type: "lead.blocked",
      actor: "system",
      source: { channel: "system", toolName: "crm_memory_backfill" },
      summary: "Existing lead block imported into CRM memory.",
      payload: {
        leadId: lead.id,
        blockedAt: lead.blocked_at,
        blockedReason: lead.blocked_reason,
        status: lead.status,
      },
    });
  }

  return drafts;
}
