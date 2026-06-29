import { describe, expect, it } from "vitest";
import { createTestDb } from "../__tests__/helpers/tmp-db.js";
import type { StoredMessage } from "../database/schema.js";
import type { LovableCrmClient, LovableLeadPayload, RemoteLovableLead } from "./lovable-client.js";
import { buildLeadSnapshotPayload } from "./lovable-client.js";
import { CrmSyncWorker } from "./worker.js";

function clientStub(input?: {
  saveLead?: (payload: LovableLeadPayload) => Promise<void>;
  listLeads?: () => Promise<{ leads: RemoteLovableLead[]; next_cursor?: string | null }>;
}): LovableCrmClient {
  return {
    saveLead: input?.saveLead ?? (async () => {}),
    listLeads: input?.listLeads ?? (async () => ({ leads: [], next_cursor: null })),
  };
}

describe("CrmSyncWorker", () => {
  it("pushes due lead snapshots to Lovable and marks them synced", async () => {
    const { db } = createTestDb();
    const sent: LovableLeadPayload[] = [];
    const lead = await db.getOrCreateLead("+5216671000000");
    await db.updateQualificationData(lead.id, {
      name: "Sergio Villarreal",
      location: "Culiacan",
      score: "HOT",
    });
    await db.storeMessage(
      message({ id: "wamid.latest", peer_e164: "+526671000000", content: "Hola, quiero paneles" }),
    );
    const now = Date.now();
    const worker = new CrmSyncWorker(
      {
        store: db,
        client: clientStub({ saveLead: async (payload) => sent.push(payload) }),
      },
      { now: () => now },
    );

    await worker.pushOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      phone_number: "+5216671000000",
      name: "Sergio Villarreal",
      location: "Culiacan",
      score: "HOT",
      source: "openclaw_whatsapp",
      openclaw_lead_id: String(lead.id),
      last_openclaw_message_id: "wamid.latest",
      last_message_preview: "Hola, quiero paneles",
      last_message_direction: "inbound",
    });
    expect(await db.getDueCrmSyncOutbox(now, 10)).toHaveLength(0);
  });

  it("reschedules failed pushes with backoff", async () => {
    const { db } = createTestDb();
    const lead = await db.getOrCreateLead("+5216671000001");
    const now = Date.now();
    const worker = new CrmSyncWorker(
      {
        store: db,
        client: clientStub({
          saveLead: async () => {
            throw new Error("Lovable unavailable");
          },
        }),
      },
      { maxAttempts: 3, now: () => now },
    );

    await worker.pushOnce();

    expect(lead.id).toBeGreaterThan(0);
    expect(await db.getDueCrmSyncOutbox(now, 10)).toHaveLength(0);
    const retry = await db.getDueCrmSyncOutbox(now + 15_000, 10);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      attempts: 1,
      last_error: "Lovable unavailable",
      status: "pending",
    });
  });

  it("queues existing leads for backfill", async () => {
    const { db } = createTestDb();
    await db.getOrCreateLead("+5216671000002");
    await db.getOrCreateLead("+5216671000003");
    await db.getDueCrmSyncOutbox(Date.now(), 10);
    const worker = new CrmSyncWorker({ store: db, client: clientStub() });

    const queued = await worker.backfillLeads(1);

    expect(queued).toBe(1);
  });

  it("applies only allowed remote CRM fields during pull", async () => {
    const { db } = createTestDb();
    const lead = await db.getOrCreateLead("+5216671000004");
    const worker = new CrmSyncWorker(
      {
        store: db,
        client: clientStub({
          listLeads: async () => ({
            leads: [
              {
                id: "remote-1",
                phone_number: "+526671000004",
                status: "handed_off",
                assigned_to_phone: "+526670000000",
                handoff_reason: "operator requested handoff",
              },
            ],
            next_cursor: "cursor-1",
          }),
        }),
      },
      { pullEnabled: true, pushEnabled: false },
    );

    await worker.pullOnce();

    const updated = await db.getLeadById(lead.id);
    expect(updated).toMatchObject({
      status: "handed_off",
      assigned_agent: "+526670000000",
    });
    expect(JSON.parse(updated!.custom_fields)).toMatchObject({
      lovable_handoff_reason: "operator requested handoff",
    });
    expect(await db.getCrmSyncCheckpoint("lovable:list-leads")).toMatchObject({
      cursor: "cursor-1",
    });
  });

  it("builds the Lovable save-lead payload shape", async () => {
    const { db } = createTestDb();
    const created = await db.upsertLead("+5216671000005", {
      name: "Aleyda",
      location: "Mazatlan",
      property_type: "casa",
      ownership: "owner",
      bimonthly_bill: 2400,
      score: "WARM",
      panels_quoted: 8,
      quote_cash: 123000,
      quote_financed: 139000,
      notes: "prefers WhatsApp",
    });
    await db.updateAssignedAgent(created.id, "+5216670000000");
    await db.updateReceiptData(created.id, {
      receipt_data: "{}",
      tariff: "1F",
      annual_kwh: 8200,
    });
    const lead = (await db.getLeadById(created.id))!;

    expect(buildLeadSnapshotPayload(lead, null)).toMatchObject({
      phone_number: "526671000005",
      name: "Aleyda",
      status: "new",
      score: "WARM",
      location: "Mazatlan",
      property_type: "casa",
      ownership: "owner",
      bimonthly_bill: 2400,
      tariff: "1F",
      annual_kwh: 8200,
      notes: "prefers WhatsApp",
      assigned_to_phone: "+5216670000000",
      source: "openclaw_whatsapp",
      panels_quoted: 8,
      quote_cash: 123000,
      quote_financed: 139000,
      openclaw_lead_id: String(lead.id),
    });
  });
});

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "wamid.default",
    chat_jid: "526671000000@s.whatsapp.net",
    sender_jid: "526671000000@s.whatsapp.net",
    sender_name: null,
    from_me: 0,
    timestamp: 1_782_500_000,
    content: "hola",
    message_type: "conversation",
    media_type: null,
    media_filename: null,
    media_size: null,
    media_path: null,
    reaction_emoji: null,
    reaction_target_id: null,
    revoked_target_id: null,
    edited_from_id: null,
    peer_e164: "+526671000000",
    created_at: Date.now(),
    ...overrides,
  };
}
