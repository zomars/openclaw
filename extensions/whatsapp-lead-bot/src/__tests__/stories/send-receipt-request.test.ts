import { describe, it, expect } from "vitest";
import { sendReceiptRequestTool } from "../../tools/send-receipt-request.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestDb } from "../helpers/tmp-db.js";

function ctx() {
  const { db } = createTestDb();
  const runtime = createFakeRuntime();
  return { db, runtime };
}

describe("send_receipt_request tool", () => {
  it("sends the canonical receipt request message", async () => {
    const c = ctx();
    await c.db.upsertLead("526671000010", { name: "Marta", bimonthly_bill: 2000 });

    const result = await sendReceiptRequestTool.execute({ phone: "526671000010" }, c);

    expect(result.success).toBe(true);
    expect(c.runtime.sentMessages).toHaveLength(1);
    expect(c.runtime.sentMessages[0].content.text).toBe(
      "Para cotizarle de forma precisa necesito ver su recibo de CFE. ¿Lo tiene a la mano?",
    );
    expect(c.runtime.sentMessages[0].content.metadata?.source).toBe("send_receipt_request");
  });

  it("returns error when lead not found", async () => {
    const c = ctx();
    const result = await sendReceiptRequestTool.execute({ phone: "999999999999" }, c);
    expect(result.success).toBe(false);
    expect(c.runtime.sentMessages).toHaveLength(0);
  });
});
