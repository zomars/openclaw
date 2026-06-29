import { describe, it, expect } from "vitest";
import { WhatsAppLabelService } from "../../labels.js";
import { blockLeadTool } from "../../tools/block-lead.js";
import { crmMemoryBackfillTool } from "../../tools/crm-memory-backfill.js";
import { getLeadTool } from "../../tools/get-lead.js";
import { handoffLeadTool } from "../../tools/handoff-lead.js";
import { listLeadsTool } from "../../tools/list-leads.js";
import { saveLeadTool } from "../../tools/save-lead.js";
import { saveReceiptDataTool } from "../../tools/save-receipt-data.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestConfig } from "../helpers/test-config.js";
import { createTestDb } from "../helpers/tmp-db.js";

function createToolContext() {
  const { db } = createTestDb();
  const runtime = createFakeRuntime();
  const labelService = new WhatsAppLabelService(
    {
      scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
      statuses: { BOT: "BOT", HUMANO: "HUMANO" },
    },
    db,
    0, // zero delay for tests
  );
  return { db, labelService, runtime };
}

describe("LLM Agent Tool Stories", () => {
  it("29. save_lead creates/updates a lead with auto-scoring and label application", async () => {
    const ctx = createToolContext();

    // Create a HOT lead (Culiacán + 2500 + propia)
    const result = await saveLeadTool.execute(
      {
        phone: "526671234567",
        name: "Juan",
        location: "Culiacán",
        ownership: "propia",
        bimonthly_bill: 2500,
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.lead!.name).toBe("Juan");

    // Score should be auto-computed as HOT
    const lead = await ctx.db.getLeadByPhone("526671234567");
    expect(lead!.score).toBe("HOT");

    // Update to a lower bill → score changes to OUT
    const result2 = await saveLeadTool.execute({ phone: "526671234567", bimonthly_bill: 300 }, ctx);
    expect(result2.success).toBe(true);
    const updated = await ctx.db.getLeadByPhone("526671234567");
    expect(updated!.score).toBe("OUT");

    // Create with only phone, no scoring fields → score stays null
    const result3 = await saveLeadTool.execute({ phone: "526671999999" }, ctx);
    expect(result3.success).toBe(true);
    const noScore = await ctx.db.getLeadByPhone("526671999999");
    expect(noScore!.score).toBeNull();
  });

  it("writes a durable CRM memory event when save_lead runs with event writes enabled", async () => {
    const ctx = createToolContext();
    const config = createTestConfig({
      crmMemory: {
        enabled: true,
        mirrorEnabled: false,
        eventWritesEnabled: true,
        contextReadsEnabled: false,
        cronGateEnabled: false,
        adminStatusEnabled: false,
      },
    });

    const result = await saveLeadTool.execute(
      {
        phone: "526671234568",
        name: "Julia",
        location: "Culiacán",
        ownership: "propia",
        bimonthly_bill: 2500,
      },
      { ...ctx, config },
    );

    expect(result.success).toBe(true);
    const events = ctx.db.read("whatsapp:526671234568");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      leadKey: "whatsapp:526671234568",
      leadPhone: "526671234568",
      type: "tool.save_lead",
      actor: "tool",
      source: {
        channel: "tool",
        toolName: "save_lead",
      },
      summary: "Lead qualification data saved.",
      payload: {
        leadId: result.lead!.id,
        fields: ["bimonthly_bill", "location", "name", "ownership"],
        previousScore: null,
        computedScore: "HOT",
        currentScore: "HOT",
      },
    });
  });

  it("30. get_lead and list_leads retrieve lead data with optional status/score filters", async () => {
    const { db } = createToolContext();

    // Create test leads
    await db.upsertLead("526671000001", { name: "Alice", score: "HOT" });
    await db.updateLeadStatus((await db.getLeadByPhone("526671000001"))!.id, "qualifying");
    await db.upsertLead("526671000002", { name: "Bob", score: "COLD" });
    await db.blockLead((await db.getLeadByPhone("526671000002"))!.id, "spam");

    // get_lead: found
    const found = await getLeadTool.execute({ phone: "526671000001" }, { db });
    expect(found.success).toBe(true);
    expect(found.lead!.name).toBe("Alice");

    // get_lead: not found
    const notFound = await getLeadTool.execute({ phone: "999999999999" }, { db });
    expect(notFound.success).toBe(false);
    expect(notFound.error).toContain("not found");

    // list_leads: no filter → all
    const all = await listLeadsTool.execute({}, { db });
    expect(all.success).toBe(true);
    expect(all.count).toBe(2);

    // list_leads: filter by status
    const blocked = await listLeadsTool.execute({ status: "blocked" }, { db });
    expect(blocked.count).toBe(1);
    expect(blocked.leads[0].name).toBe("Bob");
  });

  it("34. handoff_lead and block_lead manage lead status", async () => {
    const ctx = createToolContext();

    // Create a lead
    await ctx.db.upsertLead("526671000010", { name: "Carlos" });

    // Handoff
    const handoffResult = await handoffLeadTool.execute(
      { phone: "526671000010", reason: "needs expert" },
      ctx,
    );
    expect(handoffResult.success).toBe(true);
    expect(handoffResult.lead!.status).toBe("handed_off");

    // Create another lead for block
    await ctx.db.upsertLead("526671000011", { name: "Diana" });
    const blockResult = await blockLeadTool.execute(
      { phone: "526671000011", reason: "spam" },
      { db: ctx.db },
    );
    expect(blockResult.success).toBe(true);
    expect(blockResult.lead!.status).toBe("blocked");

    // Not found edge case
    const notFound = await handoffLeadTool.execute({ phone: "999999999999" }, ctx);
    expect(notFound.success).toBe(false);
    expect(notFound.error).toContain("not found");
  });

  it("writes durable CRM memory events for handoff_lead and block_lead when enabled", async () => {
    const ctx = createToolContext();
    const config = createTestConfig({
      crmMemory: {
        enabled: true,
        mirrorEnabled: false,
        eventWritesEnabled: true,
        contextReadsEnabled: false,
        cronGateEnabled: false,
        adminStatusEnabled: false,
      },
    });

    await ctx.db.upsertLead("526671000012", { name: "Handoff Lead" });
    await ctx.db.upsertLead("526671000013", { name: "Blocked Lead" });

    const handoffResult = await handoffLeadTool.execute(
      { phone: "526671000012", reason: "needs human follow-up" },
      { ...ctx, config },
    );
    const blockResult = await blockLeadTool.execute(
      { phone: "526671000013", reason: "spam" },
      { db: ctx.db, config },
    );

    expect(handoffResult.success).toBe(true);
    expect(blockResult.success).toBe(true);
    expect(ctx.db.read("whatsapp:526671000012")).toEqual([
      expect.objectContaining({
        leadKey: "whatsapp:526671000012",
        leadPhone: "526671000012",
        type: "tool.handoff_lead",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "handoff_lead",
        },
        summary: "Lead handed off to a human agent.",
        payload: expect.objectContaining({
          leadId: handoffResult.lead!.id,
          reason: "needs human follow-up",
          status: "handed_off",
        }),
      }),
    ]);
    expect(ctx.db.read("whatsapp:526671000013")).toEqual([
      expect.objectContaining({
        leadKey: "whatsapp:526671000013",
        leadPhone: "526671000013",
        type: "tool.block_lead",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "block_lead",
        },
        summary: "Lead blocked from bot interaction.",
        payload: expect.objectContaining({
          leadId: blockResult.lead!.id,
          reason: "spam",
          status: "blocked",
          blockedReason: "spam",
        }),
      }),
    ]);
  });

  it("backfills CRM memory events from existing lead state without duplicating events", async () => {
    const ctx = createToolContext();
    const now = Date.now();
    const lead = await ctx.db.upsertLead("526671000014", {
      name: "Backfill Lead",
      location: "Culiacán",
      ownership: "propia",
      bimonthly_bill: 2400,
      score: "HOT",
      panels_quoted: 8,
      quote_cash: 120000,
      quote_financed: 132000,
      quoted_at: now - 10_000,
    });
    await ctx.db.updateReceiptData(lead.id, {
      receipt_data: JSON.stringify({ serviceNumber: "123456789012" }),
      tariff: "1D",
      annual_kwh: 7600,
    });
    await ctx.db.updateAssignedAgent(lead.id, "Ale");
    await ctx.db.updateLeadStatus(lead.id, "handed_off");
    await ctx.db.storeMessage({
      id: "msg-backfill-1",
      chat_jid: "526671000014@s.whatsapp.net",
      sender_jid: "526671000014@s.whatsapp.net",
      sender_name: null,
      from_me: 0,
      timestamp: now - 20_000,
      content: "Quiero cotizar",
      message_type: "conversation",
      media_type: null,
      media_filename: null,
      media_size: null,
      media_path: null,
      reaction_emoji: null,
      created_at: now - 20_000,
      peer_e164: "526671000014",
    });

    const dryRun = await crmMemoryBackfillTool.execute({ dryRun: true }, { db: ctx.db });
    expect(dryRun).toMatchObject({
      success: true,
      inspected: 1,
      planned: 5,
      written: 0,
      dryRun: true,
    });
    expect(ctx.db.read("whatsapp:526671000014")).toEqual([]);

    const firstRun = await crmMemoryBackfillTool.execute({}, { db: ctx.db, now: () => now });
    const secondRun = await crmMemoryBackfillTool.execute({}, { db: ctx.db, now: () => now });

    expect(firstRun).toMatchObject({ success: true, inspected: 1, planned: 5, written: 5 });
    expect(secondRun).toMatchObject({ success: true, inspected: 1, planned: 0, written: 0 });
    expect(ctx.db.read("whatsapp:526671000014").map((event) => event.type)).toEqual([
      "lead.backfilled",
      "messages.backfilled",
      "receipt.received",
      "quote.sent",
      "handoff.started",
    ]);
  });

  it("35. sync_labels, get_labels, create_label, and add_chat_label manage WhatsApp labels", async () => {
    const { getLabelsTool, createLabelTool, addChatLabelTool } =
      await import("../../tools/label-ops.js");
    const runtime = createFakeRuntime();

    // get_labels returns labels from runtime
    const labels = await getLabelsTool.execute({} as Record<string, never>, { runtime });
    expect(labels.success).toBe(true);
    expect(labels.labels).toEqual([]);

    // create_label calls runtime.createLabel
    const created = await createLabelTool.execute({ name: "TEST", color: 5 }, { runtime });
    expect(created.success).toBe(true);
    expect(runtime.createLabelCalls).toEqual([{ name: "TEST", color: 5 }]);

    // add_chat_label calls runtime.addChatLabel
    const added = await addChatLabelTool.execute(
      { chat_jid: "526671000000@s.whatsapp.net", label_id: "42" },
      { runtime },
    );
    expect(added.success).toBe(true);
    expect(runtime.addedLabels).toEqual([{ jid: "526671000000@s.whatsapp.net", id: "42" }]);

    // Graceful degradation when runtime methods unavailable
    const minimalRuntime = { async sendMessage() {} };
    const noLabels = await getLabelsTool.execute({} as Record<string, never>, {
      runtime: minimalRuntime,
    });
    expect(noLabels.success).toBe(false);
  });

  it("36. save_receipt_data persists parsed receipt JSON to a lead record", async () => {
    const { db } = createToolContext();

    await db.upsertLead("526671000020", { name: "Elena" });

    const result = await saveReceiptDataTool.execute(
      {
        phone: "526671000020",
        receipt_data: '{"tarifa":"1C","consumo":[100,200,300]}',
        tariff: "1C",
        annual_kwh: 4500,
      },
      { db },
    );

    expect(result.success).toBe(true);
    expect(result.tariff).toBe("1C");
    expect(result.annual_kwh).toBe(4500);

    const lead = await db.getLeadByPhone("526671000020");
    expect(lead!.receipt_data).toContain("1C");
    expect(lead!.tariff).toBe("1C");
    expect(lead!.annual_kwh).toBe(4500);

    // Not found edge case
    const notFound = await saveReceiptDataTool.execute(
      { phone: "999999999999", receipt_data: "{}" },
      { db },
    );
    expect(notFound.success).toBe(false);
  });

  it("writes a durable CRM memory event when save_receipt_data runs with event writes enabled", async () => {
    const { db } = createToolContext();
    const config = createTestConfig({
      crmMemory: {
        enabled: true,
        mirrorEnabled: false,
        eventWritesEnabled: true,
        contextReadsEnabled: false,
        cronGateEnabled: false,
        adminStatusEnabled: false,
      },
    });
    await db.upsertLead("526671000021", { name: "Fernanda" });

    const result = await saveReceiptDataTool.execute(
      {
        phone: "526671000021",
        receipt_data: '{"tarifa":"1C","consumo":[100,200,300]}',
        tariff: "1C",
        annual_kwh: 4500,
      },
      { db, config },
    );

    expect(result.success).toBe(true);
    expect(db.read("whatsapp:526671000021")).toEqual([
      expect.objectContaining({
        leadKey: "whatsapp:526671000021",
        leadPhone: "526671000021",
        type: "tool.save_receipt_data",
        actor: "tool",
        source: {
          channel: "tool",
          toolName: "save_receipt_data",
        },
        summary: "Parsed CFE receipt data saved.",
        payload: {
          leadId: 1,
          tariff: "1C",
          annualKwh: 4500,
          receiptDataLength: 39,
        },
      }),
    ]);
  });
});
