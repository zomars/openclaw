import { describe, it, expect } from "vitest";
import { appendResolvedLeadEvent } from "../../crm-memory/lead-events.js";
import { getFollowupCandidatesTool } from "../../tools/get-followup-candidates.js";
import { createTestConfig } from "../helpers/test-config.js";
import { createTestDb } from "../helpers/tmp-db.js";

const DAY = 24 * 60 * 60 * 1000;

async function makeLead(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  phone: string,
  fields: {
    score?: string | null;
    status?: string;
    lastMessageDaysAgo?: number;
    follow_up_attempts?: number;
    handed_off_at?: number | null;
    blocked_at?: number | null;
    rate_limited_at?: number | null;
    receipt_data?: string | null;
    annual_kwh?: number | null;
    panels_quoted?: number | null;
    quote_cash?: number | null;
    quote_financed?: number | null;
    quoted_at?: number | null;
    pendingQuoteJobStatus?: "pending" | "delivered" | "failed";
    /** Set to true to simulate a lead that was imported (no inbound message) — excluded from followup */
    noInbound?: boolean;
  },
): Promise<string> {
  await db.upsertLead(phone, { score: fields.score ?? undefined });
  const lead = (await db.getLeadByPhone(phone))!;
  if (fields.status) {
    await db.updateLeadStatus(lead.id, fields.status as never);
  }
  const now = Date.now();
  const lastMsg = now - (fields.lastMessageDaysAgo ?? 0) * DAY;
  // Direct-write fields the public API doesn't expose. Casts kept narrow on purpose.
  const sql = (
    db as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }
  ).db;
  sql
    .prepare(
      "UPDATE leads SET last_message_at=?, follow_up_attempts=?, handed_off_at=?, blocked_at=?, rate_limited_at=? WHERE id=?",
    )
    .run(
      lastMsg,
      fields.follow_up_attempts ?? 0,
      fields.handed_off_at ?? null,
      fields.blocked_at ?? null,
      fields.rate_limited_at ?? null,
      lead.id,
    );
  sql
    .prepare(
      "UPDATE leads SET receipt_data=?, annual_kwh=?, panels_quoted=?, quote_cash=?, quote_financed=?, quoted_at=? WHERE id=?",
    )
    .run(
      fields.receipt_data ?? null,
      fields.annual_kwh ?? null,
      fields.panels_quoted ?? null,
      fields.quote_cash ?? null,
      fields.quote_financed ?? null,
      fields.quoted_at ?? null,
      lead.id,
    );
  if (fields.pendingQuoteJobStatus) {
    sql
      .prepare(
        "INSERT INTO pending_quote_jobs (request_id, customer_phone, media_path, status, next_poll_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `req-${lead.id}`,
        lead.phone_number,
        `/tmp/receipt-${lead.id}.pdf`,
        fields.pendingQuoteJobStatus,
        now,
        now,
        now,
      );
  }
  // Insert an inbound message unless explicitly excluded (simulating imported-only leads)
  if (!fields.noInbound) {
    // peer_e164 must match the normalized phone stored in the leads table
    // (REPLACE strips '+', so use the stored phone_number directly)
    const storedPhone = lead.phone_number;
    const peerE164 = storedPhone.replace(/^\+/, "");
    sql
      .prepare(
        "INSERT INTO messages (id, chat_jid, from_me, timestamp, created_at, peer_e164) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run(`msg-${peerE164}`, `${peerE164}@s.whatsapp.net`, lastMsg - 1000, now, peerE164);
  }
  return lead.phone_number;
}

describe("get_followup_candidates", () => {
  it("returns only HOT/WARM × new/qualifying leads idle 3+ days with attempts < 3 and no terminal flags", async () => {
    const { db } = createTestDb();

    // Eligible: HOT, new, idle 5d, 0 attempts
    const eligible1 = await makeLead(db, "+5216670000001", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 5,
    });
    // Eligible: WARM, qualifying, idle 4d, 1 attempt
    const eligible2 = await makeLead(db, "+5216670000002", {
      score: "WARM",
      status: "qualifying",
      lastMessageDaysAgo: 4,
      follow_up_attempts: 1,
    });
    // Ineligible: handed off
    await makeLead(db, "+5216670000003", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      handed_off_at: Date.now() - DAY,
    });
    // Ineligible: blocked
    await makeLead(db, "+5216670000004", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      blocked_at: Date.now() - DAY,
    });
    // Ineligible: rate-limited
    await makeLead(db, "+5216670000005", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      rate_limited_at: Date.now() - DAY,
    });
    // Ineligible: too recent (< 3 days idle)
    await makeLead(db, "+5216670000006", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 1,
    });
    // Ineligible: max attempts reached
    await makeLead(db, "+5216670000007", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      follow_up_attempts: 3,
    });
    // Ineligible: COLD score
    await makeLead(db, "+5216670000008", { score: "COLD", status: "new", lastMessageDaysAgo: 10 });
    // Ineligible: OUT score
    await makeLead(db, "+5216670000009", { score: "OUT", status: "new", lastMessageDaysAgo: 10 });
    // Ineligible: NULL score
    await makeLead(db, "+5216670000010", { score: null, status: "new", lastMessageDaysAgo: 10 });
    // Ineligible: handed_off status
    await makeLead(db, "+5216670000011", {
      score: "HOT",
      status: "handed_off",
      lastMessageDaysAgo: 10,
    });
    // Ineligible: already has parsed CFE receipt data
    await makeLead(db, "+5216670000012", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      receipt_data: JSON.stringify({ serviceNumber: "123456789012" }),
    });
    // Ineligible: already has annual consumption from a CFE receipt
    await makeLead(db, "+5216670000013", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      annual_kwh: 7579,
    });
    // Ineligible: already has quote data
    await makeLead(db, "+5216670000014", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      panels_quoted: 10,
      quote_cash: 150000,
      quote_financed: 165000,
      quoted_at: Date.now() - DAY,
    });
    // Ineligible: quote delivery is already queued
    await makeLead(db, "+5216670000015", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      pendingQuoteJobStatus: "pending",
    });
    // Ineligible: quote delivery already completed
    await makeLead(db, "+5216670000016", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      pendingQuoteJobStatus: "delivered",
    });
    // Eligible: failed quote job can still be followed up by the normal rules
    const failedJobLead = await makeLead(db, "+5216670000017", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
      pendingQuoteJobStatus: "failed",
    });

    const result = await getFollowupCandidatesTool.execute({}, { db });
    expect(result.success).toBe(true);
    const phones = result.leads.map((l) => l.phone_number).toSorted();
    expect(phones).toEqual([eligible1, eligible2, failedJobLead].toSorted());
  });

  it("returns leads ordered by last_message_at ASC (oldest first) and respects limit", async () => {
    const { db } = createTestDb();

    const p4d = await makeLead(db, "+5216670001001", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 4,
    });
    const p10d = await makeLead(db, "+5216670001002", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 10,
    });
    const p7d = await makeLead(db, "+5216670001003", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 7,
    });
    void p4d;

    const result = await getFollowupCandidatesTool.execute({ limit: 2 }, { db });
    expect(result.count).toBe(2);
    expect(result.leads[0].phone_number).toBe(p10d); // 10 days — oldest first
    expect(result.leads[1].phone_number).toBe(p7d); // 7 days
  });

  it("honors custom scores and statuses", async () => {
    const { db } = createTestDb();

    const cold1 = await makeLead(db, "+5216670002001", {
      score: "COLD",
      status: "new",
      lastMessageDaysAgo: 5,
    });
    await makeLead(db, "+5216670002002", { score: "HOT", status: "new", lastMessageDaysAgo: 5 });

    const cold = await getFollowupCandidatesTool.execute(
      { scores: ["COLD"], statuses: ["new"] },
      { db },
    );
    expect(cold.count).toBe(1);
    expect(cold.leads[0].phone_number).toBe(cold1);
  });

  it("skips CRM memory handoff-locked candidates when cron gate is enabled", async () => {
    const { db } = createTestDb();
    const phone = await makeLead(db, "+5216670002501", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 5,
    });
    const lead = (await db.getLeadByPhone(phone))!;
    const leadPhone = phone.replace(/^\+/, "");
    appendResolvedLeadEvent({
      scope: {
        leadKey: `whatsapp:${leadPhone}`,
        leadPhone,
      },
      log: db,
      now: () => 1782573000000,
      event: {
        type: "handoff.started",
        actor: "admin",
        source: {
          channel: "tool",
          toolName: "handoff_lead",
        },
        summary: "Ale took over the lead.",
        payload: {
          assignedAgent: "Ale",
        },
      },
    });
    const config = createTestConfig({
      crmMemory: {
        enabled: true,
        mirrorEnabled: false,
        eventWritesEnabled: true,
        contextReadsEnabled: false,
        cronGateEnabled: true,
        adminStatusEnabled: false,
      },
    });

    const result = await getFollowupCandidatesTool.execute({}, { db, config });

    expect(result.success).toBe(true);
    expect(result.leads).toEqual([]);
    expect(
      db.read(`whatsapp:${leadPhone}`).find((event) => event.type === "followup.skipped"),
    ).toMatchObject({
      type: "followup.skipped",
      actor: "cron",
      source: {
        channel: "tool",
        toolName: "get_followup_candidates",
      },
      payload: {
        leadId: lead.id,
        reason: "human_handoff_active",
        assignedAgent: "Ale",
      },
    });
  });

  it("excludes leads with invalid phone numbers (non-E.164)", async () => {
    const { db } = createTestDb();

    // Valid phone — should be included
    await makeLead(db, "+5216670003001", {
      score: "HOT",
      status: "new",
      lastMessageDaysAgo: 5,
    });

    // Now insert leads with invalid phones directly via SQL (bypassing normalizePhone)
    const sql = (
      db as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }
    ).db;
    const now = Date.now();
    const cutoff = now - 5 * DAY;

    // Too short (9 digits)
    sql
      .prepare(
        "INSERT INTO leads (phone_number, score, status, last_message_at, first_contact_at, created_at, updated_at, custom_fields) VALUES (?, 'HOT', 'new', ?, ?, ?, ?, '{}')",
      )
      .run("123456789", cutoff, now, now, now);
    sql
      .prepare(
        "INSERT INTO messages (id, chat_jid, from_me, timestamp, created_at, peer_e164) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run("msg-short", "123456789@s.whatsapp.net", cutoff - 1000, now, "123456789");

    // Too long (16 digits)
    sql
      .prepare(
        "INSERT INTO leads (phone_number, score, status, last_message_at, first_contact_at, created_at, updated_at, custom_fields) VALUES (?, 'HOT', 'new', ?, ?, ?, ?, '{}')",
      )
      .run("1234567890123456", cutoff, now, now, now);
    sql
      .prepare(
        "INSERT INTO messages (id, chat_jid, from_me, timestamp, created_at, peer_e164) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run("msg-long", "1234567890123456@s.whatsapp.net", cutoff - 1000, now, "1234567890123456");

    // Contains letters (RPU/service number)
    sql
      .prepare(
        "INSERT INTO leads (phone_number, score, status, last_message_at, first_contact_at, created_at, updated_at, custom_fields) VALUES (?, 'HOT', 'new', ?, ?, ?, ?, '{}')",
      )
      .run("RPU12345678", cutoff, now, now, now);
    sql
      .prepare(
        "INSERT INTO messages (id, chat_jid, from_me, timestamp, created_at, peer_e164) VALUES (?, ?, 0, ?, ?, ?)",
      )
      .run("msg-rpu", "RPU12345678@s.whatsapp.net", cutoff - 1000, now, "RPU12345678");

    const result = await getFollowupCandidatesTool.execute({}, { db });
    // Only the valid phone should be returned
    expect(result.count).toBe(1);
    expect(result.leads[0].phone_number).toBe("526670003001");
  });
});
