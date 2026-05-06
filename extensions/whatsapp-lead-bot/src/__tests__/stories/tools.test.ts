import { describe, it, expect } from "vitest";
import { WhatsAppLabelService } from "../../labels.js";
import { blockLeadTool } from "../../tools/block-lead.js";
import { getLeadTool } from "../../tools/get-lead.js";
import { handoffLeadTool } from "../../tools/handoff-lead.js";
import { listLeadsTool } from "../../tools/list-leads.js";
import { saveLeadTool } from "../../tools/save-lead.js";
import { saveReceiptDataTool } from "../../tools/save-receipt-data.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
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
});
