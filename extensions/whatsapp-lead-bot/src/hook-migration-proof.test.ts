/**
 * Hook Migration Proof Tests
 *
 * These tests prove that the OpenClaw plugin hook system supports the
 * capabilities needed to migrate Solayre core patches into the lead-bot
 * plugin. Run these BEFORE and AFTER migration to verify the contracts hold.
 *
 * Each test exercises a real hook runner with a mock registry — no mocking
 * of the hook infrastructure itself.
 */
import { describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../../../src/auto-reply/reply/inbound-context.js";
import {
  deriveInboundMessageHookContext,
  toPluginMessageReceivedEvent,
} from "../../../src/hooks/message-hook-mappers.js";
import { createHookRunner } from "../../../src/plugins/hooks.js";
import { createMockPluginRegistry } from "../../../src/plugins/hooks.test-helpers.js";

// ---------------------------------------------------------------------------
// 1. message_sending hook can replace outgoing text
//    Proves: Spanish error messages can move from core errors.ts to a plugin
// ---------------------------------------------------------------------------
describe("message_sending: outgoing text replacement", () => {
  it("replaces outgoing text when plugin returns { content }", async () => {
    const handler = vi.fn().mockResolvedValue({
      content: "Permitenos un momento. Te atenderemos tan pronto nos sea posible.",
    });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      {
        to: "5215512345678@s.whatsapp.net",
        content: "Rate limit exceeded — please try again later.",
        metadata: { channel: "whatsapp", openclawInitiated: true },
      },
      { channelId: "whatsapp", accountId: "default" },
    );

    expect(result?.content).toBe(
      "Permitenos un momento. Te atenderemos tan pronto nos sea posible.",
    );
  });

  it("can cancel delivery entirely with { cancel: true }", async () => {
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runMessageSending(
      {
        to: "5215512345678@s.whatsapp.net",
        content: "some message",
        metadata: { channel: "whatsapp" },
      },
      { channelId: "whatsapp" },
    );

    expect(result?.cancel).toBe(true);
  });

  it("passes original content so plugin can pattern-match errors", async () => {
    const handler = vi.fn().mockImplementation((event) => {
      if (/rate limit/i.test(event.content)) {
        return { content: "Limite de tasa excedido." };
      }
      if (/billing error/i.test(event.content)) {
        return { content: "Error de facturacion." };
      }
      return undefined; // pass through unchanged
    });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    // Rate limit error → Spanish
    const rateLimitResult = await runner.runMessageSending(
      { to: "x", content: "Rate limit exceeded", metadata: {} },
      { channelId: "whatsapp" },
    );
    expect(rateLimitResult?.content).toBe("Limite de tasa excedido.");

    // Billing error → Spanish
    const billingResult = await runner.runMessageSending(
      { to: "x", content: "API billing error — no credits", metadata: {} },
      { channelId: "whatsapp" },
    );
    expect(billingResult?.content).toBe("Error de facturacion.");

    // Normal message → no replacement
    const normalResult = await runner.runMessageSending(
      { to: "x", content: "Hello, how can I help?", metadata: {} },
      { channelId: "whatsapp" },
    );
    expect(normalResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. message_received hook exposes ctwaClid in metadata
//    Proves: lead-bot can read ctwaClid from hook event instead of core type
// ---------------------------------------------------------------------------
describe("message_received: ctwaClid in metadata", () => {
  it("exposes ctwaClid in the message_received event metadata", () => {
    const ctx = {
      CtwaClid: "clid_abc123",
      From: "5215512345678@s.whatsapp.net",
      Body: "Quiero cotizar paneles solares",
      SenderId: "5215512345678",
      Provider: "whatsapp-web",
      Surface: "whatsapp",
      ChannelId: "whatsapp",
    } as unknown as FinalizedMsgContext;

    const canonical = deriveInboundMessageHookContext(ctx);
    const event = toPluginMessageReceivedEvent(canonical);

    expect(event.metadata?.ctwaClid).toBe("clid_abc123");
  });

  it("ctwaClid is undefined when not present on context", () => {
    const ctx = {
      From: "5215512345678@s.whatsapp.net",
      Body: "Hola",
      SenderId: "5215512345678",
      Provider: "whatsapp-web",
      Surface: "whatsapp",
      ChannelId: "whatsapp",
    } as unknown as FinalizedMsgContext;

    const canonical = deriveInboundMessageHookContext(ctx);
    const event = toPluginMessageReceivedEvent(canonical);

    expect(event.metadata?.ctwaClid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. message_received hook exposes sentByAccountOwner in metadata
//    Proves: lead-bot can detect owner messages via hooks, not core type patch
// ---------------------------------------------------------------------------
describe("message_received: sentByAccountOwner in metadata", () => {
  it("exposes isAccountOwnerMessage as sentByAccountOwner", () => {
    const ctx = {
      From: "5215512345678@s.whatsapp.net",
      Body: "test",
      SenderId: "5215512345678",
      Provider: "whatsapp-web",
      Surface: "whatsapp",
      ChannelId: "whatsapp",
      IsAccountOwnerMessage: true,
    } as unknown as FinalizedMsgContext;

    const canonical = deriveInboundMessageHookContext(ctx);
    const event = toPluginMessageReceivedEvent(canonical);

    expect(event.metadata?.sentByAccountOwner).toBe(true);
  });

  it("sentByAccountOwner is undefined when not an owner message", () => {
    const ctx = {
      From: "5215500000000@s.whatsapp.net",
      Body: "hola",
      SenderId: "5215500000000",
      Provider: "whatsapp-web",
      Surface: "whatsapp",
      ChannelId: "whatsapp",
    } as unknown as FinalizedMsgContext;

    const canonical = deriveInboundMessageHookContext(ctx);
    const event = toPluginMessageReceivedEvent(canonical);

    expect(event.metadata?.sentByAccountOwner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. before_agent_reply hook can short-circuit with a synthetic reply
//    Proves: plugin can intercept and handle messages without LLM involvement
// ---------------------------------------------------------------------------
describe("before_agent_reply: synthetic reply short-circuit", () => {
  it("returns synthetic reply and skips LLM when handled=true", async () => {
    const handler = vi.fn().mockResolvedValue({
      handled: true,
      reply: { text: "Gracias por tu mensaje. Un asesor te contactara pronto." },
      reason: "lead-bot-handoff",
    });
    const registry = createMockPluginRegistry([{ hookName: "before_agent_reply", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(
      { cleanedBody: "quiero hablar con alguien" },
      {
        runId: "run-1",
        agentId: "solayre",
        sessionKey: "whatsapp:5215512345678",
        channelId: "whatsapp",
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply).toEqual({
      text: "Gracias por tu mensaje. Un asesor te contactara pronto.",
    });
  });

  it("swallows message silently when handled=true without reply", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: true });
    const registry = createMockPluginRegistry([{ hookName: "before_agent_reply", handler }]);
    const runner = createHookRunner(registry);

    const result = await runner.runBeforeAgentReply(
      { cleanedBody: "ignored message" },
      { runId: "run-2", agentId: "solayre", channelId: "whatsapp" },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. message_sending hook receives channel metadata
//    Proves: plugin can scope behavior to whatsapp-only (not replace all channels)
// ---------------------------------------------------------------------------
describe("message_sending: channel-scoped behavior", () => {
  it("handler receives channel in metadata for scoped replacement", async () => {
    const handler = vi.fn().mockImplementation((event) => {
      // Only replace for WhatsApp
      if (event.metadata?.channel !== "whatsapp") {
        return undefined;
      }
      if (/overloaded/i.test(event.content)) {
        return { content: "Servicio temporalmente no disponible." };
      }
      return undefined;
    });
    const registry = createMockPluginRegistry([{ hookName: "message_sending", handler }]);
    const runner = createHookRunner(registry);

    // WhatsApp → replaced
    const waResult = await runner.runMessageSending(
      { to: "x", content: "Service overloaded", metadata: { channel: "whatsapp" } },
      { channelId: "whatsapp" },
    );
    expect(waResult?.content).toBe("Servicio temporalmente no disponible.");

    // Telegram → untouched
    const tgResult = await runner.runMessageSending(
      { to: "x", content: "Service overloaded", metadata: { channel: "telegram" } },
      { channelId: "telegram" },
    );
    expect(tgResult).toBeUndefined();
  });
});
