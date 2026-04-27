import { describe, it, expect } from "vitest";
import { WhatsAppLabelService } from "../../labels.js";
import { sendDisqualificationTool } from "../../tools/send-disqualification.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestDb } from "../helpers/tmp-db.js";

function ctx() {
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
  return { db, runtime, labelService };
}

describe("send_disqualification tool", () => {
  it("sends out_of_state canonical message and marks lead ignored", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000001", { name: "Pedro" });

    const result = await sendDisqualificationTool.execute(
      { phone: "526671000001", reason: "out_of_state" },
      c,
    );

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages).toHaveLength(1);
    expect(c.runtime.sentMessages[0].content.text).toBe(
      "Por el momento solo operamos en Sinaloa. Agradezco su interés.",
    );
    expect(c.runtime.sentMessages[0].content.metadata?.openclawInitiated).toBe(true);
    expect(c.runtime.sentMessages[0].content.metadata?.source).toBe("send_disqualification");

    const updated = await c.db.getLeadByPhone("526671000001");
    expect(updated!.status).toBe("ignored");
  });

  it("sends tenant canonical message", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000002", {});

    const result = await sendDisqualificationTool.execute(
      { phone: "526671000002", reason: "tenant" },
      c,
    );

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages[0].content.text).toBe(
      "La instalación requiere ser propietario del inmueble. Le sugiero comentarlo con el dueño.",
    );
  });

  it("sends low_bill canonical message", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000003", {});

    const result = await sendDisqualificationTool.execute(
      { phone: "526671000003", reason: "low_bill" },
      c,
    );

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages[0].content.text).toBe(
      "Con ese nivel de consumo el retorno de inversión sería muy largo. En este momento no sería conveniente para usted.",
    );
  });

  it("returns error when lead not found", async () => {
    const c = ctx();
    const result = await sendDisqualificationTool.execute(
      { phone: "999999999999", reason: "out_of_state" },
      c,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(c.runtime.sentMessages).toHaveLength(0);
  });

  it("rejects invalid reason without sending", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000004", {});

    const result = await sendDisqualificationTool.execute(
      // @ts-expect-error testing runtime validation
      { phone: "526671000004", reason: "made_up" },
      c,
    );
    expect(result.success).toBe(false);
    expect(c.runtime.sentMessages).toHaveLength(0);
  });
});
