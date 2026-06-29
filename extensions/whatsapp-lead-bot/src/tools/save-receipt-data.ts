/**
 * Tool: save_receipt_data
 *
 * Saves parsed CFE receipt data to a lead record.
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import { appendResolvedLeadEvent } from "../crm-memory/lead-events.js";
import { resolveCrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { Database } from "../database.js";
import { normalizePhone } from "../utils/phone.js";

export const saveReceiptDataTool = {
  name: "save_receipt_data",
  description:
    "Save parsed CFE receipt data (tariff, annual kWh, raw JSON) to a lead's database record.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      receipt_data: {
        type: "string" as const,
        description: "JSON string of parsed receipt data",
      },
      tariff: { type: "string" as const, description: "CFE tariff type (e.g. 1, 1A, DAC)" },
      annual_kwh: { type: "number" as const, description: "Annual kWh consumption" },
    },
    required: ["phone", "receipt_data"],
  },
  execute: async (
    params: { phone: string; receipt_data: string; tariff?: string; annual_kwh?: number },
    context: { db: Database; config?: WhatsAppLeadBotConfig },
  ) => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.db.updateReceiptData(lead.id, {
      receipt_data: params.receipt_data,
      tariff: params.tariff,
      annual_kwh: params.annual_kwh,
    });
    appendReceiptDataCrmEvent({
      db: context.db,
      config: context.config,
      lead,
      params,
    });

    return {
      success: true,
      leadId: lead.id,
      tariff: params.tariff ?? null,
      annual_kwh: params.annual_kwh ?? null,
    };
  },
};

function appendReceiptDataCrmEvent(input: {
  db: Database;
  config?: WhatsAppLeadBotConfig;
  lead: NonNullable<Awaited<ReturnType<Database["getLeadByPhone"]>>>;
  params: { phone: string; receipt_data: string; tariff?: string; annual_kwh?: number };
}): void {
  const flags = resolveCrmMemoryRolloutFlags(input.config?.crmMemory);
  if (!flags.eventWritesEnabled) {
    return;
  }

  const leadPhone = normalizePhone(input.lead.phone_number || input.params.phone);
  if (!leadPhone) {
    return;
  }

  try {
    appendResolvedLeadEvent({
      scope: {
        leadKey: `whatsapp:${leadPhone}`,
        leadPhone,
      },
      log: input.db,
      event: {
        type: "tool.save_receipt_data",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "save_receipt_data",
        },
        summary: "Parsed CFE receipt data saved.",
        payload: {
          leadId: input.lead.id,
          tariff: input.params.tariff ?? null,
          annualKwh: input.params.annual_kwh ?? null,
          receiptDataLength: input.params.receipt_data.length,
        },
      },
    });
  } catch (err) {
    console.error(`[save_receipt_data] Failed to append CRM memory event:`, err);
  }
}
