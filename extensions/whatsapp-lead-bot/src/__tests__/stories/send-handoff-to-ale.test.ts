import { describe, it, expect } from "vitest";
import { HandoffManager } from "../../handoff/manager.js";
import { WhatsAppLabelService } from "../../labels.js";
import { sendHandoffToAleTool } from "../../tools/send-handoff-to-ale.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestDb } from "../helpers/tmp-db.js";

function ctx(agentNumbers: string[] = ["526672178748"]) {
  const { db } = createTestDb();
  const runtime = createFakeRuntime();
  const labelService = new WhatsAppLabelService(
    {
      scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
      statuses: { BOT: "BOT", HUMANO: "HUMANO" },
    },
    db,
    0,
  );
  const handoffManager = new HandoffManager(db);
  return { db, runtime, labelService, handoffManager, agentNumbers };
}

describe("send_handoff_to_ale tool", () => {
  it("sends customer ack, marks handed_off, and notifies agents", async () => {
    const c = ctx(["526672178748"]);
    await c.db.upsertLead("526671000020", {
      name: "Diana",
      location: "Mazatlán",
      bimonthly_bill: 3200,
      property_type: "habitacional",
    });

    const result = await sendHandoffToAleTool.execute({ phone: "526671000020" }, c);

    expect(result.success).toBe(true);

    const customerMsg = c.runtime.sentMessages.find((m) => m.to === "526671000020");
    expect(customerMsg?.content.text).toBe(
      "Con gusto, en breve le comunicaremos con un asesor para coordinar los detalles.",
    );

    const aleMsg = c.runtime.sentMessages.find((m) => m.to === "526672178748");
    expect(aleMsg?.content.text).toContain("Hola Ale");
    expect(aleMsg?.content.text).toContain("Diana");
    expect(aleMsg?.content.text).toContain("526671000020");
    expect(aleMsg?.content.text).toContain("Mazatlán");
    expect(aleMsg?.content.text).toContain("3,200");
    expect(aleMsg?.content.text).not.toContain("**");
    expect(aleMsg?.content.text).not.toContain("🤝");

    const lead = await c.db.getLeadByPhone("526671000020");
    expect(lead!.status).toBe("handed_off");
  });

  it("notifies multiple agent numbers", async () => {
    const c = ctx(["526671111111", "526672222222"]);
    await c.db.upsertLead("526671000021", { name: "Carlos" });

    await sendHandoffToAleTool.execute({ phone: "526671000021" }, c);

    expect(c.runtime.sentMessages.find((m) => m.to === "526671111111")).toBeDefined();
    expect(c.runtime.sentMessages.find((m) => m.to === "526672222222")).toBeDefined();
  });

  it("works when no agent numbers configured (still sends customer ack)", async () => {
    const c = ctx([]);
    await c.db.upsertLead("526671000022", { name: "Luis" });

    const result = await sendHandoffToAleTool.execute({ phone: "526671000022" }, c);

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages).toHaveLength(1);
    expect(c.runtime.sentMessages[0].to).toBe("526671000022");
  });

  it("returns error when lead not found", async () => {
    const c = ctx();
    const result = await sendHandoffToAleTool.execute({ phone: "999999999999" }, c);
    expect(result.success).toBe(false);
    expect(c.runtime.sentMessages).toHaveLength(0);
  });

  it("handoff agent message handles missing optional context gracefully", async () => {
    const c = ctx(["526672178748"]);
    await c.db.upsertLead("526671000023", {});

    await sendHandoffToAleTool.execute({ phone: "526671000023" }, c);

    const aleMsg = c.runtime.sentMessages.find((m) => m.to === "526672178748");
    expect(aleMsg?.content.text).toContain("Un prospecto");
    expect(aleMsg?.content.text).toContain("526671000023");
    expect(aleMsg?.content.text).toContain("Aún sin información detallada");
  });
});
