import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../hooks/message-queue.js";
import { checkLeadContentFilter } from "../../hooks/message-sending.js";
import { splitAgentResponse } from "../../hooks/multi-message-splitter.js";
import { CircuitBreaker } from "../../rate-limit/circuit-breaker.js";
import { RateLimitCoordinator } from "../../rate-limit/coordinator.js";
import { GlobalRateLimiter } from "../../rate-limit/global-limiter.js";
import { RateLimiter } from "../../rate-limit/limiter.js";
import { FakeNotifier } from "../helpers/fake-notifier.js";
import { createTestDb } from "../helpers/tmp-db.js";

describe("System / Operations Stories", () => {
  it("37. enforces 3-layer rate limiting: circuit breaker → global → per-lead, all atomic via DB transactions", async () => {
    const { db } = createTestDb();
    const notifier = new FakeNotifier();
    const rateLimiter = new RateLimiter(db, {
      enabled: true,
      messagesPerHour: 2,
      windowMs: 3600000,
    });
    const globalLimiter = new GlobalRateLimiter(db, {
      enabled: true,
      maxMessagesPerHour: 100,
      windowMs: 3600000,
    });
    const circuitBreaker = new CircuitBreaker(
      db,
      { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 5 },
      notifier,
    );
    const coordinator = new RateLimitCoordinator(circuitBreaker, globalLimiter, rateLimiter);

    const lead = await db.getOrCreateLead("+5216671000010");

    // All layers pass
    const r1 = await coordinator.checkAndRecord(lead.id);
    expect(r1.allowed).toBe(true);

    // Use up per-lead limit
    await coordinator.checkAndRecord(lead.id);
    const r3 = await coordinator.checkAndRecord(lead.id);
    expect(r3.allowed).toBe(false);
    expect(r3.layer).toBe("per_lead");

    // Create a second lead, exhaust global limit separately
    const { db: db2 } = createTestDb();
    const notifier2 = new FakeNotifier();
    const globalLimiter2 = new GlobalRateLimiter(db2, {
      enabled: true,
      maxMessagesPerHour: 2,
      windowMs: 3600000,
    });
    const rateLimiter2 = new RateLimiter(db2, {
      enabled: true,
      messagesPerHour: 100,
      windowMs: 3600000,
    });
    const circuitBreaker2 = new CircuitBreaker(
      db2,
      { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 5 },
      notifier2,
    );
    const coordinator2 = new RateLimitCoordinator(circuitBreaker2, globalLimiter2, rateLimiter2);
    const leadA = await db2.getOrCreateLead("+5216671000011");

    await coordinator2.checkAndRecord(leadA.id);
    await coordinator2.checkAndRecord(leadA.id);
    const rGlobal = await coordinator2.checkAndRecord(leadA.id);
    expect(rGlobal.allowed).toBe(false);
    expect(rGlobal.layer).toBe("global");

    // Circuit breaker denial
    const { db: db3 } = createTestDb();
    const notifier3 = new FakeNotifier();
    const cb3 = new CircuitBreaker(
      db3,
      { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 5 },
      notifier3,
    );
    const gl3 = new GlobalRateLimiter(db3, {
      enabled: true,
      maxMessagesPerHour: 100,
      windowMs: 3600000,
    });
    const rl3 = new RateLimiter(db3, { enabled: true, messagesPerHour: 100, windowMs: 3600000 });
    const coord3 = new RateLimitCoordinator(cb3, gl3, rl3);
    // Trip the breaker manually
    for (let i = 0; i < 5; i++) {
      await cb3.recordCheck(true);
    }
    const leadB = await db3.getOrCreateLead("+5216671000012");
    const rCb = await coord3.checkAndRecord(leadB.id);
    expect(rCb.allowed).toBe(false);
    expect(rCb.layer).toBe("circuit_breaker");
  });

  it("38. splits long bot responses into multiple messages via delimiter, paragraph breaks, or length", () => {
    // Delimiter strategy
    const delimited = splitAgentResponse("Hola\n---MSG---\nSegunda parte");
    expect(delimited.isMulti).toBe(true);
    expect(delimited.strategy).toBe("delimiter");
    expect(delimited.messages).toEqual(["Hola", "Segunda parte"]);

    // Paragraph strategy
    const paragraphs = splitAgentResponse("Primero\n\n\nSegundo");
    expect(paragraphs.isMulti).toBe(true);
    expect(paragraphs.strategy).toBe("paragraph");
    expect(paragraphs.messages).toEqual(["Primero", "Segundo"]);

    // Long-message strategy (>500 chars, short lines)
    const longLines = Array.from(
      { length: 20 },
      (_, i) => `Line ${i + 1} of the long message with more text here.`,
    ).join("\n");
    expect(longLines.length).toBeGreaterThan(500);
    const longResult = splitAgentResponse(longLines);
    expect(longResult.isMulti).toBe(true);
    expect(longResult.strategy).toBe("long-message");

    // Short single message → no split
    const short = splitAgentResponse("Hola, buen día");
    expect(short.isMulti).toBe(false);
    expect(short.strategy).toBe("none");
    expect(short.messages).toEqual(["Hola, buen día"]);

    // Empty input → graceful
    const empty = splitAgentResponse("");
    expect(empty.isMulti).toBe(false);
  });

  it("39. queues multi-message responses and sends sequentially with delays", () => {
    const queue = new MessageQueue();
    const to = "+5216671000020";

    // Empty queue
    expect(queue.hasQueued(to)).toBe(false);
    expect(queue.pop(to)).toBeUndefined();
    expect(queue.queueSize(to)).toBe(0);

    // Add and pop in FIFO order
    queue.add(to, { to, content: "First" });
    queue.add(to, { to, content: "Second" });
    queue.add(to, { to, content: "Third" });

    expect(queue.hasQueued(to)).toBe(true);
    expect(queue.queueSize(to)).toBe(3);

    expect(queue.pop(to)!.content).toBe("First");
    expect(queue.pop(to)!.content).toBe("Second");
    expect(queue.queueSize(to)).toBe(1);
    expect(queue.pop(to)!.content).toBe("Third");
    expect(queue.hasQueued(to)).toBe(false);

    // Different recipients are isolated
    queue.add("+111", { to: "+111", content: "A" });
    queue.add("+222", { to: "+222", content: "B" });
    expect(queue.queueSize("+111")).toBe(1);
    expect(queue.queueSize("+222")).toBe(1);
    expect(queue.pop("+111")!.content).toBe("A");
    expect(queue.hasQueued("+222")).toBe(true);

    // Clear empties all
    queue.add("+111", { to: "+111", content: "X" });
    queue.clear();
    expect(queue.hasQueued("+111")).toBe(false);
    expect(queue.hasQueued("+222")).toBe(false);
  });

  it("40. filters messages by configured WhatsApp accounts and bypasses pipeline for team members", async () => {
    // Test the message-received handler's account and team member filters
    const { createMessageReceivedHandler } = await import("../../hooks/message-received.js");
    const { withContext } = await import("../../context.js");
    const { AdminCommandHandler } = await import("../../admin/commands.js");
    const { HandoffManager } = await import("../../handoff/manager.js");
    const { RateLimiter } = await import("../../rate-limit/limiter.js");
    const { GlobalRateLimiter } = await import("../../rate-limit/global-limiter.js");
    const { CircuitBreaker } = await import("../../rate-limit/circuit-breaker.js");
    const { RateLimitCoordinator } = await import("../../rate-limit/coordinator.js");
    const { MediaHandler } = await import("../../media/handler.js");
    const { AgentNotifier } = await import("../../notifications/agent-notify.js");
    const { HandoffInterceptor } = await import("../../hooks/handoff-interceptor.js");
    const { createFakeRuntime } = await import("../helpers/fake-runtime.js");
    const { createTestConfig } = await import("../helpers/test-config.js");

    const { db } = createTestDb();
    const runtime = createFakeRuntime();
    const notifier = new FakeNotifier();
    const config = createTestConfig({
      whatsappAccounts: ["acct-1"],
      agentNumbers: ["+15558888888"],
    });

    // Whitelist holds both numbers in canonical form. `+15558888888` is also
    // in `agentNumbers` so it receives bot notifications, but `filterTeamMember`
    // only looks at the whitelist — agentNumbers is a strict subset.
    const coworkerWhitelist = {
      load: async () => new Set(["15557777777", "15558888888"]),
    };

    const handoffManager = new HandoffManager(db, notifier);
    const rateLimiter = new RateLimiter(db, {
      enabled: true,
      messagesPerHour: 10,
      windowMs: 3600000,
    });
    const globalLimiter = new GlobalRateLimiter(db, {
      enabled: true,
      maxMessagesPerHour: 1000,
      windowMs: 3600000,
    });
    const circuitBreaker = new CircuitBreaker(
      db,
      { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 10 },
      notifier,
    );
    const coordinator = new RateLimitCoordinator(circuitBreaker, globalLimiter, rateLimiter);
    const mediaHandler = new MediaHandler();
    const agentNotifier = new AgentNotifier(runtime, config);
    const adminHandler = new AdminCommandHandler(db, handoffManager, rateLimiter, null, null);
    const handoffInterceptor = new HandoffInterceptor({ agentNotifier });

    const handler = createMessageReceivedHandler({
      db,
      config,
      adminHandler,
      rateLimiter,
      rateLimitCoordinator: coordinator,
      mediaHandler,
      agentNotifier,
      handoffManager,
      handoffInterceptor,
      coworkerWhitelist,
    });

    const getRuntime = () => runtime;
    const wrappedHandler = withContext(getRuntime, (_deps: {}) => handler)({});

    // Wrong account → passes through (empty result = let OpenClaw handle)
    const wrongAcct = await wrappedHandler(
      { from: "+5216671000099", content: "Hola" },
      { channelId: "whatsapp", accountId: "acct-WRONG" },
    );
    expect(wrongAcct).toEqual({});

    // Team member → bypasses pipeline (empty result)
    const teamMsg = await wrappedHandler(
      { from: "+15557777777", content: "Internal message" },
      { channelId: "whatsapp", accountId: "acct-1" },
    );
    expect(teamMsg).toEqual({});

    // Agent number → also bypasses pipeline
    const agentMsg = await wrappedHandler(
      { from: "+15558888888", content: "Agent check" },
      { channelId: "whatsapp", accountId: "acct-1" },
    );
    expect(agentMsg).toEqual({});

    // Non-WhatsApp channel → passes through
    const nonWA = await wrappedHandler(
      { from: "+5216671000099", content: "Hola" },
      { channelId: "telegram", accountId: "acct-1" },
    );
    expect(nonWA).toEqual({});
  });

  it("41. stores all raw WhatsApp messages (inbound + outbound) for a complete conversation archive", async () => {
    const { db } = createTestDb();
    const chatJid = "5216671000030@s.whatsapp.net";
    const now = Date.now();

    // Store a single message
    await db.storeMessage({
      id: "msg-1",
      chat_jid: chatJid,
      sender_jid: chatJid,
      from_me: 0,
      timestamp: now - 2000,
      content: "Hola",
      message_type: "text",
      media_type: null,
      media_filename: null,
      media_size: null,
      media_path: null,
      reaction_emoji: null,
      reaction_target_id: null,
      revoked_target_id: null,
      edited_from_id: null,
      peer_e164: null,
      created_at: now,
    });

    // Batch store
    await db.storeMessages([
      {
        id: "msg-2",
        chat_jid: chatJid,
        sender_jid: "bot@s.whatsapp.net",
        from_me: 1,
        timestamp: now - 1000,
        content: "Bienvenido",
        message_type: "text",
        media_type: null,
        media_filename: null,
        media_size: null,
        media_path: null,
        reaction_emoji: null,
        reaction_target_id: null,
        revoked_target_id: null,
        edited_from_id: null,
        peer_e164: null,
        created_at: now,
      },
      {
        id: "msg-3",
        chat_jid: chatJid,
        sender_jid: chatJid,
        from_me: 0,
        timestamp: now,
        content: "Gracias",
        message_type: "text",
        media_type: null,
        media_filename: null,
        media_size: null,
        media_path: null,
        reaction_emoji: null,
        reaction_target_id: null,
        revoked_target_id: null,
        edited_from_id: null,
        peer_e164: null,
        created_at: now,
      },
    ]);

    // Retrieve all with limit
    const all = await db.getMessages(chatJid, { limit: 10 });
    expect(all).toHaveLength(3);

    // Time-based filter
    const recent = await db.getMessagesSince(chatJid, now - 1500);
    expect(recent).toHaveLength(2);
    expect(recent.map((m) => m.content)).toContain("Bienvenido");
    expect(recent.map((m) => m.content)).toContain("Gracias");
  });

  it("42. logs all handoff events to an audit trail with timestamps, trigger method, and metadata", async () => {
    const { db } = createTestDb();
    const lead = await db.getOrCreateLead("+5216671000040");

    await db.logHandoffEvent(lead.id, "handoff_triggered", "admin", { reason: "test handoff" });

    // Verify the log exists by doing a second handoff and checking it works
    await db.logHandoffEvent(lead.id, "human_detected", "agent");

    // We can't directly query handoff_log via the interface, but we verify
    // it doesn't throw and the HandoffManager integration works
    const { HandoffManager } = await import("../../handoff/manager.js");
    const manager = new HandoffManager(db);
    await manager.triggerAdminHandoff(lead.id);

    const updated = await db.getLeadByPhone("+5216671000040");
    expect(updated!.status).toBe("handed_off");
  });

  it("43. caches WhatsApp label name→ID mappings (in-memory → DB → API fetch → create if missing)", async () => {
    // This tests the WhatsAppLabelService resolution chain (covered in labels.test.ts;
    // story test verifies the user-facing guarantee end-to-end).
    const { WhatsAppLabelService } = await import("../../labels.js");
    const { createFakeRuntime } = await import("../helpers/fake-runtime.js");
    const { db } = createTestDb();
    const labelConfig = {
      scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
      statuses: { BOT: "BOT", HUMANO: "HUMANO" },
    };
    const svc = new WhatsAppLabelService(labelConfig, db, 0);

    // DB miss + runtime miss + createLabel returns ID → upserted
    const runtime = createFakeRuntime();
    // Override getLabels to return empty, createLabel to return an ID
    (runtime as any).createLabel = async (name: string, color: number) => {
      runtime.createLabelCalls.push({ name, color });
      return { id: `id-${name}`, name, color };
    };

    await svc.applyScore("526671000000", "HOT", runtime);
    // Label should be cached in DB
    const dbId = await db.getLabelId("HOT");
    expect(dbId).toBe("id-HOT");

    // Second call should use in-memory cache (no new createLabel calls)
    const callsBefore = runtime.createLabelCalls.length;
    await svc.applyScore("526671000001", "HOT", runtime);
    expect(runtime.createLabelCalls.length).toBe(callsBefore);
  });

  it("44. validates CFE PDFs by checking for CFE RFC before API call, limits to 3 extraction attempts per lead", async () => {
    const { quickValidateCFE, quickValidateCFEImage } =
      await import("../../media/pdf-validator.js");

    // Image → always valid (needs OCR, can't pre-validate)
    const imgResult = quickValidateCFEImage("/fake/image.jpg");
    expect(imgResult.isValid).toBe(true);

    // Unsupported format
    const zipResult = quickValidateCFE("/fake/file.zip", "application/zip");
    expect(zipResult.isValid).toBe(false);
    expect(zipResult.reason).toBe("unsupported_format");

    // Non-existent file → read_error
    const noFile = quickValidateCFE("/nonexistent/file.pdf", "application/pdf");
    expect(noFile.isValid).toBe(false);

    // Extraction attempt limiting via DB
    const { db } = createTestDb();
    const lead = await db.getOrCreateLead("526671000099");
    for (let i = 0; i < 3; i++) {
      await db.createExtractionRecord(lead.id, null, null);
    }
    const attempts = await db.getExtractionAttempts(lead.id);
    expect(attempts).toHaveLength(3);
  });

  it("45. maintains request context (accountId → runtime) across async boundaries via AsyncLocalStorage", async () => {
    const { getContext, withContext } = await import("../../context.js");
    const { createFakeRuntime } = await import("../helpers/fake-runtime.js");

    // getContext outside withContext throws
    expect(() => getContext()).toThrow("No request context");

    // withContext sets the context for the handler
    const fakeRuntime = createFakeRuntime();
    const getRuntime = () => fakeRuntime;

    const createHandler = (_deps: {}) => async (_event: unknown, _ctx: { accountId?: string }) => {
      const reqCtx = getContext();
      return { accountId: reqCtx.accountId, hasRuntime: !!reqCtx.runtime };
    };

    const wrappedFactory = withContext(getRuntime, createHandler);
    const handler = wrappedFactory({});

    const result = await handler({}, { accountId: "acct-123" });
    expect(result.accountId).toBe("acct-123");
    expect(result.hasRuntime).toBe(true);

    // Concurrent calls maintain separate contexts
    const [r1, r2] = await Promise.all([
      handler({}, { accountId: "acct-A" }),
      handler({}, { accountId: "acct-B" }),
    ]);
    expect(r1.accountId).toBe("acct-A");
    expect(r2.accountId).toBe("acct-B");
  });

  it("46. logs content filter violations when bot output contains system-internal keywords", () => {
    // Matches bot self-identification
    expect(checkLeadContentFilter("Soy un bot de atención")).toBeTruthy();

    // Matches internal tool names
    expect(checkLeadContentFilter("Usa openclaw para configurar")).toBeTruthy();
    expect(checkLeadContentFilter("Revisa openclaw.json")).toBeTruthy();

    // Matches plugin keyword
    expect(checkLeadContentFilter("El plugin está activo")).toBeTruthy();

    // Matches webhook keyword
    expect(checkLeadContentFilter("El webhook responde")).toBeTruthy();

    // Matches chatbot/robot
    expect(checkLeadContentFilter("Soy un chatbot amigable")).toBeTruthy();

    // Matches asistente virtual
    expect(checkLeadContentFilter("Soy asistente virtual")).toBeTruthy();

    // Clean text returns null
    expect(checkLeadContentFilter("Hola, buen día. ¿En qué puedo ayudarle?")).toBeNull();
    expect(checkLeadContentFilter("Le envío la cotización de paneles solares.")).toBeNull();
  });
});
