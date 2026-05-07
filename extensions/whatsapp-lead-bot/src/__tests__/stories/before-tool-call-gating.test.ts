import { describe, it, expect } from "vitest";
import { createBeforeToolCallHandler } from "../../hooks/before-tool-call.js";
import type { PluginHookBeforeToolCallEvent } from "../../types.js";
import { createTestDb } from "../helpers/tmp-db.js";

const SESSION = "agent:solayre-leads:whatsapp:default:direct:526671000060";

function evt(toolName: string, params: Record<string, unknown>): PluginHookBeforeToolCallEvent {
  return { toolName, params };
}

describe("before_tool_call tool gating", () => {
  it("blocks process_cfe_receipt_customer when lead is in AWAITING_NAME", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000060", {}); // bare lead → AWAITING_NAME

    const handler = createBeforeToolCallHandler({ db });
    const result = await handler(
      evt("process_cfe_receipt_customer", { phone: "526671000060", billId: "uuid" }),
      { sessionKey: SESSION },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("AWAITING_NAME");
    expect(result?.blockReason).toContain("process_cfe_receipt_customer");
  });

  it("allows save_lead in AWAITING_NAME", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000061", {});

    const handler = createBeforeToolCallHandler({ db });
    const result = await handler(evt("save_lead", { phone: "526671000061", name: "Pedro" }), {
      sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000061",
    });

    expect(result).toBeUndefined();
  });

  it("allows process_cfe_receipt_customer in READY_TO_QUOTE", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000062", {
      name: "Pedro",
      location: "Culiacán",
      ownership: "propia",
      property_type: "habitacional",
      bimonthly_bill: 2500,
    });
    const lead = await db.getLeadByPhone("526671000062");
    await db.updateReceiptData(lead!.id, {
      receipt_data: JSON.stringify({ bill_id: "uuid-abc" }),
    });

    const handler = createBeforeToolCallHandler({ db });
    const result = await handler(
      evt("process_cfe_receipt_customer", { phone: "526671000062", billId: "uuid-abc" }),
      { sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000062" },
    );

    expect(result).toBeUndefined();
  });

  it("blocks all message tool calls for HANDED_OFF leads", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000063", { name: "Pedro" });
    const lead = await db.getLeadByPhone("526671000063");
    await db.updateLeadStatus(lead!.id, "handed_off");

    const handler = createBeforeToolCallHandler({ db });
    const result = await handler(
      evt("message", { action: "send", target: "whatsapp:526671000063", message: "hola" }),
      { sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000063" },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("HANDED_OFF");
  });

  it("allows introspection tools regardless of state", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000064", {});
    const lead = await db.getLeadByPhone("526671000064");
    await db.updateLeadStatus(lead!.id, "handed_off");

    const handler = createBeforeToolCallHandler({ db });
    const result = await handler(evt("get_lead", { phone: "526671000064" }), {
      sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000064",
    });

    expect(result).toBeUndefined();
  });

  it("falls back to pricing-only guardrail when DB is not provided", async () => {
    const handler = createBeforeToolCallHandler();
    const blocked = await handler(
      evt("message", { action: "send", target: "whatsapp:x", message: "$50,000" }),
    );
    expect(blocked?.block).toBe(true);

    const allowed = await handler(
      evt("process_cfe_receipt_customer", { phone: "x", billId: "uuid" }),
    );
    expect(allowed).toBeUndefined();
  });

  it("dryRun gating logs but does not block", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000065", {});

    const handler = createBeforeToolCallHandler({ db, dryRun: true });
    const result = await handler(
      evt("process_cfe_receipt_customer", { phone: "526671000065", billId: "uuid" }),
      { sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000065" },
    );

    expect(result).toBeUndefined();
  });

  it("does not gate when invoking agent does not match expectedAgentId", async () => {
    const { db } = createTestDb();
    // Lead in QUOTED state — would normally block process_cfe_receipt.
    await db.upsertLead("526671000066", {
      name: "Coworker",
      status: "qualified",
      panels_quoted: 12,
    });

    const handler = createBeforeToolCallHandler({ db, expectedAgentId: "solayre-leads" });
    const result = await handler(
      evt("process_cfe_receipt", { mediaPath: "/x", coworkerPhone: "526671000066" }),
      { sessionKey: "agent:solayre-coworker:whatsapp:default:direct:526671000066" },
    );

    // No gating from the lead-funnel hooks for sibling agents.
    expect(result).toBeUndefined();
  });
});
