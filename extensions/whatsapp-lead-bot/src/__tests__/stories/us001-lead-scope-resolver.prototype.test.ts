import { describe, expect, it } from "vitest";
import { resolveCurrentLeadScope } from "../../crm-memory/us001-lead-scope-resolver.prototype.js";

describe("US-001 lead scope resolver prototype", () => {
  it("resolves the current lead from trusted WhatsApp sender metadata", () => {
    const result = resolveCurrentLeadScope({
      runtime: {
        channelId: "whatsapp",
        accountId: "solayre-main",
        conversationId: "chat-667",
        from: "+52 1 667 123 4567@c.us",
      },
      messageText: "Hola, quiero cotizar paneles.",
    });

    expect(result).toEqual({
      ok: true,
      scope: {
        channelId: "whatsapp",
        accountId: "solayre-main",
        conversationId: "chat-667",
        leadPhone: "526671234567",
        leadKey: "whatsapp:526671234567",
        source: "runtime.from",
      },
    });
  });

  it("ignores phone numbers mentioned in message text", () => {
    const result = resolveCurrentLeadScope({
      runtime: {
        channelId: "whatsapp",
        from: "+52 1 667 111 0000",
      },
      messageText: "Mi vecino es +52 1 667 999 9999 y tambien quiere info, pero esta es mi cuenta.",
    });

    expect(result).toMatchObject({
      ok: true,
      scope: {
        leadPhone: "526671110000",
        leadKey: "whatsapp:526671110000",
      },
    });
  });

  it("falls back to the trusted senderPhone metadata field when from is absent", () => {
    const result = resolveCurrentLeadScope({
      runtime: {
        channelId: "whatsapp",
        senderPhone: "5216692223333@s.whatsapp.net",
      },
      messageText: "El telefono correcto segun el texto es 5216670000000",
    });

    expect(result).toEqual({
      ok: true,
      scope: {
        channelId: "whatsapp",
        accountId: undefined,
        conversationId: undefined,
        leadPhone: "526692223333",
        leadKey: "whatsapp:526692223333",
        source: "runtime.senderPhone",
      },
    });
  });

  it("refuses to resolve without trusted WhatsApp sender metadata", () => {
    expect(
      resolveCurrentLeadScope({
        runtime: { channelId: "whatsapp" },
        messageText: "Soy +52 1 667 123 4567",
      }),
    ).toEqual({ ok: false, reason: "missing_trusted_sender" });
  });

  it("refuses non-WhatsApp runtime scope", () => {
    expect(
      resolveCurrentLeadScope({
        runtime: {
          channelId: "telegram",
          from: "+52 1 667 123 4567",
        },
      }),
    ).toEqual({ ok: false, reason: "unsupported_channel" });
  });
});
