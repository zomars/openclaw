import { describe, expect, it } from "vitest";
import { AdminCommandHandler } from "../../admin/commands.js";
import { HandoffManager } from "../../handoff/manager.js";
import { RateLimiter } from "../../rate-limit/limiter.js";
import { sendQuoteUrlTool } from "../../tools/send-quote-url.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestDb } from "../helpers/tmp-db.js";

const NOW = 1_800_000;

function sqlFor(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return (
    db as unknown as {
      db: {
        prepare: (q: string) => {
          run: (...args: unknown[]) => void;
        };
      };
    }
  ).db;
}

async function createLeadWithQuoteUrl(input: {
  phone?: string;
  quoteNumber?: string;
  expiresAt?: number | null;
}) {
  const { db } = createTestDb();
  const phone = input.phone ?? "526671234567";
  const quoteNumber = input.quoteNumber ?? "SOL20260702-abcd";
  const lead = await db.upsertLead(phone, { name: "Cliente" });
  await db.updateQuoteData(lead.id, { panels_quoted: 8, quoted_at: NOW - 10_000 });
  sqlFor(db)
    .prepare(
      `INSERT INTO pending_quote_jobs (
        request_id, customer_phone, media_path, status, attempts, next_poll_at,
        quote_id, quote_number, quote_access_token_id, quote_access_url,
        quote_access_expires_at, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'delivered', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "req_quote_url",
      phone,
      "/tmp/receipt.pdf",
      NOW,
      "quote_123",
      quoteNumber,
      "qat_123",
      `https://app.solayre.mx/q/token-${quoteNumber}`,
      input.expiresAt === undefined ? NOW + 60_000 : input.expiresAt,
      NOW - 20_000,
      NOW - 10_000,
      NOW - 10_000,
    );
  return { db, phone, quoteNumber };
}

describe("send_quote_url operator pilot", () => {
  it("sends the latest stored active quote URL to a selected lead", async () => {
    const { db, phone, quoteNumber } = await createLeadWithQuoteUrl({});
    const runtime = createFakeRuntime();

    const result = await sendQuoteUrlTool.execute({ phone }, { db, runtime, now: () => NOW });

    expect(result).toEqual({
      success: true,
      quoteNumber,
      url: `https://app.solayre.mx/q/token-${quoteNumber}`,
    });
    expect(runtime.sentMessages).toHaveLength(1);
    expect(runtime.sentMessages[0]).toMatchObject({
      to: phone,
      content: {
        text: expect.stringContaining(`https://app.solayre.mx/q/token-${quoteNumber}`),
        metadata: {
          source: "send_quote_url",
          quoteNumber,
          quoteAccessTokenId: "qat_123",
        },
      },
    });

    const lead = await db.getLeadByPhone(phone);
    expect(lead?.last_bot_reply_at).toBe(NOW);
  });

  it("does not send expired or missing stored quote URLs", async () => {
    const { db, phone } = await createLeadWithQuoteUrl({ expiresAt: NOW - 1 });
    const runtime = createFakeRuntime();

    const result = await sendQuoteUrlTool.execute({ phone }, { db, runtime, now: () => NOW });

    expect(result).toEqual({
      success: false,
      error: "No active stored quote URL found for lead",
    });
    expect(runtime.sentMessages).toHaveLength(0);
  });

  it("supports admin command parsing and explicit quote folio sends", async () => {
    const { db, phone, quoteNumber } = await createLeadWithQuoteUrl({ expiresAt: null });
    const runtime = createFakeRuntime();
    const handoffManager = new HandoffManager(db);
    const rateLimiter = new RateLimiter(db, {
      enabled: true,
      messagesPerHour: 10,
      windowMs: 3_600_000,
    });
    const handler = new AdminCommandHandler(db, handoffManager, rateLimiter, null, null);

    expect(handler.parseCommand(`/send-quote-url ${phone} ${quoteNumber}`)).toEqual({
      type: "send-quote-url",
      phone,
      quoteNumber,
    });

    const response = await handler.execute({ type: "send-quote-url", phone, quoteNumber }, runtime);

    expect(response).toBe(`✅ URL de cotización enviada: ${quoteNumber}`);
    expect(runtime.sentMessages).toHaveLength(1);
    expect(runtime.sentMessages[0].content.metadata).toMatchObject({
      source: "admin:send-quote-url",
      quoteNumber,
    });
  });
});
