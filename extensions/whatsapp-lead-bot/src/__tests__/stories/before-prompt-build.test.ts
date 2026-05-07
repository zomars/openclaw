import { describe, it, expect } from "vitest";
import {
  createBeforePromptBuildHandler,
  phoneFromSessionKey,
} from "../../hooks/before-prompt-build.js";
import { createTestDb } from "../helpers/tmp-db.js";

describe("phoneFromSessionKey", () => {
  it("extracts phone from a well-formed sessionKey", () => {
    expect(phoneFromSessionKey("agent:solayre-leads:whatsapp:default:direct:526671234567")).toBe(
      "526671234567",
    );
  });

  it("returns null for malformed keys", () => {
    expect(phoneFromSessionKey(undefined)).toBeNull();
    expect(phoneFromSessionKey("")).toBeNull();
    expect(phoneFromSessionKey("not:a:session:key")).toBeNull();
    expect(phoneFromSessionKey("agent:x:whatsapp:y:group:526671234567")).toBeNull();
  });
});

describe("before_prompt_build handler", () => {
  it("injects the AWAITING_NAME prompt for a brand-new lead", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000050", {});

    const handler = createBeforePromptBuildHandler({ db });
    const result = await handler(
      { prompt: "", messages: [] },
      {
        channelId: "whatsapp",
        sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000050",
      },
    );

    expect(result?.prependContext).toBeDefined();
    expect(result?.prependContext).toContain("AWAITING_NAME");
  });

  it("injects READY_TO_QUOTE when lead has bill_id in receipt_data", async () => {
    const { db } = createTestDb();
    await db.upsertLead("526671000051", {
      name: "Pedro",
      location: "Culiacán",
      ownership: "propia",
      property_type: "habitacional",
      bimonthly_bill: 2500,
    });
    const lead = await db.getLeadByPhone("526671000051");
    await db.updateReceiptData(lead!.id, {
      receipt_data: JSON.stringify({ bill_id: "uuid-abc" }),
    });

    const handler = createBeforePromptBuildHandler({ db });
    const result = await handler(
      { prompt: "", messages: [] },
      {
        channelId: "whatsapp",
        sessionKey: "agent:solayre-leads:whatsapp:default:direct:526671000051",
      },
    );

    expect(result?.prependContext).toContain("READY_TO_QUOTE");
    expect(result?.prependContext).toContain("process_cfe_receipt_customer");
  });

  it("returns nothing for non-whatsapp channels", async () => {
    const { db } = createTestDb();
    const handler = createBeforePromptBuildHandler({ db });
    const result = await handler(
      { prompt: "", messages: [] },
      { channelId: "telegram", sessionKey: "agent:x:telegram:y:direct:123" },
    );
    expect(result).toBeUndefined();
  });

  it("returns nothing when lead does not exist", async () => {
    const { db } = createTestDb();
    const handler = createBeforePromptBuildHandler({ db });
    const result = await handler(
      { prompt: "", messages: [] },
      {
        channelId: "whatsapp",
        sessionKey: "agent:solayre-leads:whatsapp:default:direct:999999999999",
      },
    );
    expect(result).toBeUndefined();
  });

  it("returns nothing when invoking agent does not match expectedAgentId", async () => {
    const { db } = createTestDb();
    // Lead exists for the phone — would normally trigger state injection.
    await db.upsertLead("526671000099", {
      name: "Coworker",
      status: "qualified",
      panels_quoted: 12,
    });
    const handler = createBeforePromptBuildHandler({ db, expectedAgentId: "solayre-leads" });
    const result = await handler(
      { prompt: "", messages: [] },
      {
        channelId: "whatsapp",
        // Coworker agent — must not get the lead state prompt.
        sessionKey: "agent:solayre-coworker:whatsapp:default:direct:526671000099",
      },
    );
    expect(result).toBeUndefined();
  });
});
