import { describe, it, expect } from "vitest";
import { AdminCommandHandler } from "../../admin/commands.js";
import { appendResolvedLeadEvent } from "../../crm-memory/lead-events.js";
import type { CrmMemoryRolloutFlags } from "../../crm-memory/rollout.js";
import type { Lead } from "../../database/schema.js";
import { HandoffManager } from "../../handoff/manager.js";
import { HandoffInterceptor } from "../../hooks/handoff-interceptor.js";
import { WhatsAppLabelService } from "../../labels.js";
import { AgentNotifier } from "../../notifications/agent-notify.js";
import { CircuitBreaker } from "../../rate-limit/circuit-breaker.js";
import { GlobalRateLimiter } from "../../rate-limit/global-limiter.js";
import { RateLimiter } from "../../rate-limit/limiter.js";
import { normalizePhone } from "../../utils/phone.js";
import { FakeNotifier } from "../helpers/fake-notifier.js";
import { createFakeRuntime } from "../helpers/fake-runtime.js";
import { createTestConfig } from "../helpers/test-config.js";
import { createTestDb } from "../helpers/tmp-db.js";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 1,
    phone_number: "+5216671000000",
    status: "new",
    created_at: Date.now(),
    updated_at: Date.now(),
    first_contact_at: Date.now(),
    last_message_at: Date.now(),
    last_bot_reply_at: null,
    handed_off_at: null,
    blocked_at: null,
    rate_limited_at: null,
    follow_up_sent_at: null,
    quoted_at: null,
    assigned_agent: null,
    blocked_reason: null,
    language: null,
    name: null,
    location: null,
    property_type: null,
    ownership: null,
    bimonthly_bill: null,
    score: null,
    panels_quoted: null,
    quote_cash: null,
    quote_financed: null,
    notes: null,
    receipt_data: null,
    tariff: null,
    annual_kwh: null,
    rate_limit_count: 0,
    rate_limit_window_start: 0,
    follow_up_attempts: 0,
    survey_sent_at: null,
    instagram_reminder_sent_at: null,
    custom_fields: "{}",
    ...overrides,
  };
}

function createAdminHandler(opts?: {
  labelService?: WhatsAppLabelService | null;
  crmMemory?: Partial<CrmMemoryRolloutFlags> | null;
}) {
  const { db } = createTestDb();
  const notifier = new FakeNotifier();
  const handoffManager = new HandoffManager(db, notifier);
  const rateLimiter = new RateLimiter(db, {
    enabled: true,
    messagesPerHour: 10,
    windowMs: 3600000,
  });
  const circuitBreaker = new CircuitBreaker(
    db,
    { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 5 },
    notifier,
  );
  const globalLimiter = new GlobalRateLimiter(db, {
    enabled: true,
    maxMessagesPerHour: 100,
    windowMs: 3600000,
  });
  const handler = new AdminCommandHandler(
    db,
    handoffManager,
    rateLimiter,
    null,
    null,
    circuitBreaker,
    globalLimiter,
    opts?.labelService ?? null,
    opts?.crmMemory ?? null,
  );
  return { handler, db, notifier, circuitBreaker, globalLimiter, rateLimiter };
}

describe("Agent / Admin Stories", () => {
  it("12. notifies agents via WhatsApp for new leads, qualified leads, handoffs, rate limits, and circuit breaker events", async () => {
    const runtime = createFakeRuntime();
    const config = createTestConfig({ agentNumbers: ["+15551111111", "+15552222222"] });
    const notifier = new AgentNotifier(runtime, config);

    const lead = {
      id: 1,
      phone_number: "+5216671000050",
      status: "qualifying" as const,
      name: "Juan Pérez",
      location: "Culiacán",
      property_type: "casa",
      ownership: "propia",
      bimonthly_bill: 2500,
      score: "HOT",
      created_at: Date.now() - 60000,
      updated_at: Date.now(),
      first_contact_at: Date.now() - 60000,
      last_message_at: Date.now(),
      last_bot_reply_at: null,
      handed_off_at: null,
      blocked_at: null,
      rate_limited_at: null,
      follow_up_sent_at: null,
      quoted_at: null,
      assigned_agent: null,
      blocked_reason: null,
      language: null,
      panels_quoted: null,
      quote_cash: null,
      quote_financed: null,
      notes: null,
      receipt_data: null,
      tariff: null,
      annual_kwh: null,
      rate_limit_count: 0,
      rate_limit_window_start: 0,
      follow_up_attempts: 0,
      survey_sent_at: null,
      instagram_reminder_sent_at: null,
      custom_fields: "{}",
    };

    await notifier.notifyNewLead(lead);
    expect(runtime.sentMessages.length).toBe(2);
    expect(runtime.sentMessages[0].to).toBe("+15551111111");
    expect(runtime.sentMessages[1].to).toBe("+15552222222");

    runtime.sentMessages.length = 0;
    await notifier.notifyQualified(lead);
    expect(runtime.sentMessages.length).toBe(2);
    expect(runtime.sentMessages[0].content.text).toContain("HOT");

    runtime.sentMessages.length = 0;
    await notifier.notifyHandoff(lead, "Manual handoff");
    expect(runtime.sentMessages.length).toBe(2);
    expect(runtime.sentMessages[0].content.text).toContain("Manual handoff");

    runtime.sentMessages.length = 0;
    await notifier.notifyRateLimit(lead, "10 messages per hour exceeded");
    expect(runtime.sentMessages.length).toBe(2);

    runtime.sentMessages.length = 0;
    await notifier.notifyCircuitTripped("80% hit rate");
    expect(runtime.sentMessages.length).toBe(2);

    runtime.sentMessages.length = 0;
    const silentConfig = createTestConfig({
      notifyNewLeads: false,
      agentNumbers: ["+15551111111"],
    });
    const silentNotifier = new AgentNotifier(runtime, silentConfig);
    await silentNotifier.notifyNewLead(lead);
    expect(runtime.sentMessages.length).toBe(0);
  });

  it("13. /status shows lead full profile and qualification data", () => {
    const { db } = createTestDb();
    const handoffManager = new HandoffManager(db);
    const rateLimiter = new RateLimiter(db, {
      enabled: true,
      messagesPerHour: 10,
      windowMs: 3600000,
    });
    const handler = new AdminCommandHandler(db, handoffManager, rateLimiter, null, null);

    expect(handler.parseCommand("/status +5216671234567")).toEqual({
      type: "status",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/block +5216671234567 spam")).toEqual({
      type: "block",
      phone: "526671234567",
      reason: "spam",
    });
    expect(handler.parseCommand("/unblock +5216671234567")).toEqual({
      type: "unblock",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/handoff +5216671234567")).toEqual({
      type: "handoff",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/takeback +5216671234567")).toEqual({
      type: "takeback",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/reset-lead +5216671234567")).toEqual({
      type: "reset-lead",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/clear-limit +5216671234567")).toEqual({
      type: "clear-limit",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/followup +5216671234567")).toEqual({
      type: "followup",
      phone: "526671234567",
    });
    expect(handler.parseCommand("/score +5216671234567 HOT")).toEqual({
      type: "score",
      phone: "526671234567",
      score: "HOT",
    });
    expect(handler.parseCommand("/score +5216671234567 INVALID")).toBeNull();
    expect(handler.parseCommand("/recent")).toEqual({ type: "recent", count: 5 });
    expect(handler.parseCommand("/recent 20")).toEqual({ type: "recent", count: 20 });
    expect(handler.parseCommand("/rate-status")).toEqual({ type: "rate-status" });
    expect(handler.parseCommand("/reset-breaker")).toEqual({ type: "reset-breaker" });
    expect(handler.parseCommand("/sync-leads")).toEqual({ type: "sync-leads" });
    expect(handler.parseCommand("/sync-labels")).toEqual({ type: "sync-labels" });
    expect(handler.parseCommand("/pending")).toEqual({ type: "pending" });
    expect(handler.parseCommand("/pause")).toEqual({ type: "pause" });
    expect(handler.parseCommand("/resume")).toEqual({ type: "resume" });
    expect(handler.parseCommand("/help")).toEqual({ type: "help" });
    expect(handler.parseCommand("/unknown")).toBeNull();
    expect(handler.parseCommand("not a command")).toBeNull();
    expect(handler.parseCommand("/status")).toBeNull();
  });

  it("13b. /status uses CRM memory admin status when enabled", async () => {
    const { handler, db } = createAdminHandler({
      crmMemory: {
        enabled: true,
        adminStatusEnabled: true,
      },
    });
    const lead = await db.getOrCreateLead("+5216671000072");
    const leadPhone = normalizePhone(lead.phone_number);

    appendResolvedLeadEvent({
      scope: {
        leadKey: `whatsapp:${leadPhone}`,
        leadPhone,
      },
      log: db,
      now: () => 1782319000000,
      event: {
        type: "receipt.received",
        actor: "tool",
        source: {
          channel: "whatsapp",
          toolName: "process_lead_cfe_receipt",
        },
        summary: "Receipt parsed for admin status.",
        payload: {
          bimonthlyBill: 3450,
          artifact: {
            id: "receipt-admin",
            type: "cfe_receipt",
            pointer: "cfe/receipt-admin.pdf",
          },
        },
      },
    });

    const result = await handler.execute({ type: "status", phone: lead.phone_number });

    expect(result).toContain("**CRM Lead Status**");
    expect(result).toContain(`Phone: ${leadPhone}`);
    expect(result).toContain("Bill: 3450");
    expect(result).toContain("Artifacts: 1");
    expect(result).toContain("Timeline events: 1");
    expect(result).toContain("Next: review_receipt_and_quote");
  });

  it("13c. /status keeps legacy output by default", async () => {
    const { handler, db } = createAdminHandler();
    const lead = await db.getOrCreateLead("+5216671000073");
    await db.updateQualificationData(lead.id, {
      name: "Legacy Lead",
      location: "Culiacán",
      bimonthly_bill: 2100,
      score: "WARM",
    });

    const result = await handler.execute({ type: "status", phone: lead.phone_number });

    expect(result).toContain("**Lead Status**");
    expect(result).toContain("Name: Legacy Lead");
    expect(result).toContain("Score: WARM");
    expect(result).not.toContain("**CRM Lead Status**");
  });

  it("13d. /status keeps legacy output when CRM admin status is disabled", async () => {
    const { handler, db } = createAdminHandler({
      crmMemory: {
        enabled: true,
        adminStatusEnabled: false,
      },
    });
    const lead = await db.getOrCreateLead("+5216671000074");

    const result = await handler.execute({ type: "status", phone: lead.phone_number });

    expect(result).toContain("**Lead Status**");
    expect(result).not.toContain("**CRM Lead Status**");
  });

  it("14. /recent lists N most recent leads with status and time since last message", async () => {
    const { handler, db } = createAdminHandler();

    const l1 = await db.getOrCreateLead("+5216671000001");
    const l2 = await db.getOrCreateLead("+5216671000002");
    const l3 = await db.getOrCreateLead("+5216671000003");

    // Set distinct timestamps so ordering is deterministic
    await db.updateLeadTimestamp(l1.id, Date.now() - 3000);
    await db.updateLeadTimestamp(l2.id, Date.now() - 1000);
    await db.updateLeadTimestamp(l3.id, Date.now());

    const result = await handler.execute({ type: "recent", count: 2 });
    expect(result).toContain("Recent Leads (2)");
    // Most recent 2 should be l3 and l2
    expect(result).toContain("5216671000003");
    expect(result).toContain("5216671000002");
    expect(result).not.toContain("5216671000001");
  });

  it("15. /pending lists leads waiting for a response", async () => {
    const { handler, db } = createAdminHandler();

    // Lead A: qualifying, messaged after bot reply → pending
    const lA = await db.getOrCreateLead("+5216671000010");
    await db.updateLeadStatus(lA.id, "qualifying");
    await db.updateLeadTimestamp(lA.id, Date.now());
    await db.updateLastBotReply(lA.id, Date.now() - 5000);

    // Lead B: new, has message but no bot reply → pending
    const lB = await db.getOrCreateLead("+5216671000011");
    await db.updateLeadTimestamp(lB.id, Date.now());

    // Lead C: qualifying, bot replied after lead message → NOT pending
    const lC = await db.getOrCreateLead("+5216671000012");
    await db.updateLeadStatus(lC.id, "qualifying");
    await db.updateLeadTimestamp(lC.id, Date.now() - 5000);
    await db.updateLastBotReply(lC.id, Date.now());

    const result = await handler.execute({ type: "pending" });
    expect(result).toContain("pendientes (2)");
    expect(result).toContain("5216671000010");
    expect(result).toContain("5216671000011");
    expect(result).not.toContain("5216671000012");
  });

  it("16. /block and /unblock control which leads the bot engages", async () => {
    const { handler, db } = createAdminHandler();
    await db.getOrCreateLead("+5216671000020");

    // Block
    const blockResult = await handler.execute({
      type: "block",
      phone: "526671000020",
      reason: "spam",
    });
    expect(blockResult).toContain("Blocked");
    const blocked = await db.getLeadByPhone("+5216671000020");
    expect(blocked!.status).toBe("blocked");
    expect(blocked!.blocked_reason).toBe("spam");

    // Unblock
    const unblockResult = await handler.execute({ type: "unblock", phone: "526671000020" });
    expect(unblockResult).toContain("Unblocked");
    const unblocked = await db.getLeadByPhone("+5216671000020");
    expect(unblocked!.status).not.toBe("blocked");

    // Not found
    const notFound = await handler.execute({
      type: "block",
      phone: "999999999999",
      reason: "test",
    });
    expect(notFound).toContain("Lead not found");
  });

  it("17. /handoff manually takes over a conversation from the bot", async () => {
    const { handler, db } = createAdminHandler();
    const lead = await db.getOrCreateLead("+5216671000030");
    await db.updateLeadStatus(lead.id, "qualifying");

    const result = await handler.execute({ type: "handoff", phone: "526671000030" });
    expect(result).toContain("Handoff triggered");
    const updated = await db.getLeadByPhone("+5216671000030");
    expect(updated!.status).toBe("handed_off");
  });

  it("18. /takeback returns a lead to bot handling with a summary of missed messages", async () => {
    const { handler, db } = createAdminHandler();
    // Use normalized phone to avoid lookup mismatch
    const phone = "526671000035";
    const lead = await db.getOrCreateLead(phone);
    await db.updateLeadStatus(lead.id, "handed_off");

    const result = await handler.execute({ type: "takeback", phone });
    expect(result).toContain("Takeback");
    const updated = await db.getLeadByPhone(phone);
    expect(updated!.status).toBe("qualifying");

    // Not handed off → error
    const errResult = await handler.execute({ type: "takeback", phone });
    expect(errResult).toContain("not handed off");
  });

  it("19. /reset-lead wipes qualification data and restarts conversation fresh", async () => {
    const { handler, db } = createAdminHandler();
    const phone = "526671000040";
    const lead = await db.getOrCreateLead(phone);
    await db.updateQualificationData(lead.id, { name: "Juan", location: "Culiacán", score: "HOT" });

    const result = await handler.execute({ type: "reset-lead", phone });
    expect(result).toContain("Reset lead");
    expect(result).toContain("No active OpenClaw session");

    const updated = await db.getLeadByPhone(phone);
    expect(updated!.status).toBe("qualifying"); // resetLead sets to qualifying
    expect(updated!.name).toBeNull();
    expect(updated!.location).toBeNull();
    expect(updated!.score).toBeNull();
  });

  it("20. /score manually overrides a lead score", async () => {
    const { handler, db } = createAdminHandler();
    await db.getOrCreateLead("+5216671000045");

    const result = await handler.execute({ type: "score", phone: "526671000045", score: "WARM" });
    expect(result).toContain("Score set");
    expect(result).toContain("WARM");

    const updated = await db.getLeadByPhone("+5216671000045");
    expect(updated!.score).toBe("WARM");
  });

  it("21. /clear-limit unblocks a rate-limited lead", async () => {
    const { handler, db, rateLimiter } = createAdminHandler();
    const lead = await db.getOrCreateLead("+5216671000050");

    // Exhaust rate limit
    for (let i = 0; i < 10; i++) {
      await db.checkAndRecordMessage(lead.id, 10, 3600000);
    }
    await db.updateLeadStatus(lead.id, "rate_limited");

    const result = await handler.execute({ type: "clear-limit", phone: "526671000050" });
    expect(result).toContain("Rate limit cleared");

    const updated = await db.getLeadByPhone("+5216671000050");
    expect(updated!.status).toBe("qualifying");

    // Rate limit should be cleared
    const check = await rateLimiter.checkLimit(lead.id);
    expect(check.allowed).toBe(true);
  });

  it("22. /rate-status shows circuit breaker state, hit rate, global limit usage, and rate-limited lead count", async () => {
    const { handler, circuitBreaker, globalLimiter } = createAdminHandler();

    await circuitBreaker.recordCheck(false);
    await circuitBreaker.recordCheck(false);
    await globalLimiter.record();

    const result = await handler.execute({ type: "rate-status" });
    expect(result).toContain("Circuit Breaker: OK");
    expect(result).toContain("Hit rate:");
    expect(result).toContain("Global Limit:");
    expect(result).toContain("Rate-limited leads:");
  });

  it("23. /pause emergency-stops all bot responses by tripping circuit breaker", async () => {
    const { handler, circuitBreaker } = createAdminHandler();

    const result = await handler.execute({ type: "pause" });
    expect(result).toContain("Bot pausado");

    const status = await circuitBreaker.getStatus();
    expect(status.isTripped).toBe(true);

    // Already paused
    const again = await handler.execute({ type: "pause" });
    expect(again).toContain("ya está pausado");
  });

  it("24. /resume and /reset-breaker bring the bot back online", async () => {
    const { handler, circuitBreaker, notifier } = createAdminHandler();

    // Pause first
    await handler.execute({ type: "pause" });
    expect((await circuitBreaker.getStatus()).isTripped).toBe(true);

    // Resume
    const result = await handler.execute({ type: "resume" });
    expect(result).toContain("Bot reactivado");
    expect((await circuitBreaker.getStatus()).isTripped).toBe(false);
    expect(notifier.resets).toBeGreaterThanOrEqual(1);

    // Already active
    const again = await handler.execute({ type: "resume" });
    expect(again).toContain("ya está activo");
  });

  it("25. /followup sends an immediate follow-up and records the attempt", async () => {
    const { handler, db } = createAdminHandler();
    const lead = await db.getOrCreateLead("+5216671000060");
    await db.updateLeadStatus(lead.id, "qualifying");
    await db.updateFollowUpSentAt(lead.id, Date.now());
    const sent: { to: string; text: string }[] = [];
    const runtime = {
      async sendMessage(to: string, content: { text: string }) {
        sent.push({ to, text: content.text });
      },
    };

    const result = await handler.execute({ type: "followup", phone: "526671000060" }, runtime);
    expect(result).toContain("Seguimiento enviado");
    expect(sent).toEqual([
      {
        to: "+5216671000060",
        text: "Hola, ¿pudo conseguir su recibo de CFE? Con él le preparo su cotización personalizada sin costo.",
      },
    ]);

    const updated = await db.getLeadByPhone("+5216671000060");
    expect(updated!.follow_up_attempts).toBe(1);
    expect(updated!.follow_up_sent_at).toBeGreaterThan(0);
    expect(updated!.last_bot_reply_at).toBeGreaterThan(0);

    // Blocked lead
    const blockedLead = await db.getOrCreateLead("+5216671000061");
    await db.updateLeadStatus(blockedLead.id, "blocked");
    const blockedResult = await handler.execute(
      { type: "followup", phone: "526671000061" },
      runtime,
    );
    expect(blockedResult).toContain("bloqueado");
  });

  it("26. /sync-leads recomputes all scores and /sync-labels recomputes scores + syncs WhatsApp labels", async () => {
    const { handler, db } = createAdminHandler();

    // Create leads with scoring data
    await db.upsertLead("526671000070", {
      name: "A",
      location: "Culiacán",
      ownership: "propia",
      bimonthly_bill: 2500,
    });
    await db.upsertLead("526671000071", {
      name: "B",
      location: "Mazatlán",
      ownership: "propia",
      bimonthly_bill: 800,
    });

    const result = await handler.execute({ type: "sync-leads" });
    expect(result).toContain("Sync Leads");
    expect(result).toContain("Recomputed: 2");

    // Verify scores were written
    const leadA = await db.getLeadByPhone("526671000070");
    expect(leadA!.score).toBe("HOT");
    const leadB = await db.getLeadByPhone("526671000071");
    expect(leadB!.score).toBe("COLD");

    // Running again should report no changes
    const result2 = await handler.execute({ type: "sync-leads" });
    expect(result2).toContain("No score changes");
  });

  it("27. /help displays all available commands", async () => {
    const { handler } = createAdminHandler();
    const result = await handler.execute({ type: "help" });

    expect(result).toContain("Admin Commands");
    expect(result).toContain("/followup <phone> - Enviar seguimiento inmediato a un lead");
    expect(result).not.toContain("próximo ciclo");
    for (const cmd of [
      "/status",
      "/block",
      "/unblock",
      "/handoff",
      "/takeback",
      "/reset-lead",
      "/clear-limit",
      "/score",
      "/recent",
      "/pending",
      "/pause",
      "/resume",
      "/followup",
      "/rate-status",
      "/help",
    ]) {
      expect(result).toContain(cmd);
    }
  });

  it("28. silently captures incoming messages and media during handoff, notifying agent on receipt arrival", async () => {
    const runtime = createFakeRuntime();
    const config = createTestConfig({ agentNumbers: ["+15559999999"] });
    const agentNotifier = new AgentNotifier(runtime, config);
    const interceptor = new HandoffInterceptor({ agentNotifier });

    const lead = makeLead({ id: 1, status: "handed_off", name: "Test" });

    // Non-handed-off lead → returns null (pass through)
    const nonHandoff = await interceptor.handle({
      event: { from: "+5216671000090", content: "Hola" },
      lead: makeLead({ status: "qualifying" }),
    });
    expect(nonHandoff).toBeNull();

    // Handed-off lead with text → suppress, no notification for text
    const textResult = await interceptor.handle({
      event: { from: "+5216671000090", content: "Hola" },
      lead,
    });
    expect(textResult).toEqual({ suppress: true });

    // Handed-off lead with non-receipt media → suppress + notifyHandoffCapture
    runtime.sentMessages.length = 0;
    const mediaResult = await interceptor.handle({
      event: { from: "+5216671000090", content: "video", metadata: { mediaType: "video/mp4" } },
      lead,
    });
    expect(mediaResult).toEqual({ suppress: true });
    expect(runtime.sentMessages.length).toBeGreaterThan(0);

    // Handed-off lead with receipt-type media (no cfeParseContext) → suppress + notifyHandoffCapture
    runtime.sentMessages.length = 0;
    const receiptResult = await interceptor.handle({
      event: {
        from: "+5216671000090",
        content: "pdf",
        metadata: { mediaType: "application/pdf", mediaPath: "/fake/receipt.pdf" },
      },
      lead,
    });
    expect(receiptResult).toEqual({ suppress: true });
    // Should notify since it detected receipt media (even without CFE context)
    expect(runtime.sentMessages.length).toBeGreaterThan(0);
  });
});
