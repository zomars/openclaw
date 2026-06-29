import { describe, expect, it, vi } from "vitest";
import { sendLeadBotWhatsAppMessage } from "./send-whatsapp.js";

describe("sendLeadBotWhatsAppMessage", () => {
  it("uses the active WhatsApp runtime send function when available", async () => {
    const sendMessageWhatsApp = vi.fn(async () => ({ messageId: "msg-1", toJid: "jid-1" }));
    const fallbackSendWebChannelMessage = vi.fn(async () => ({ messageId: "fallback" }));

    await sendLeadBotWhatsAppMessage({
      to: "+5216672350818",
      text: "Queued reply",
      mediaUrl: "/tmp/quote.pdf",
      accountId: "solayre",
      sendMessageWhatsApp,
      fallbackSendWebChannelMessage,
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith("+5216672350818", "Queued reply", {
      verbose: false,
      cfg: undefined,
      accountId: "solayre",
      mediaUrl: "/tmp/quote.pdf",
      preserveLeadingWhitespace: true,
    });
    expect(fallbackSendWebChannelMessage).not.toHaveBeenCalled();
  });

  it("falls back to the web-channel helper when no active runtime send function is exposed", async () => {
    const fallbackSendWebChannelMessage = vi.fn(async () => ({ messageId: "fallback" }));

    await sendLeadBotWhatsAppMessage({
      to: "+5216672350818",
      text: "Queued reply",
      accountId: "solayre",
      fallbackSendWebChannelMessage,
    });

    expect(fallbackSendWebChannelMessage).toHaveBeenCalledWith("+5216672350818", "Queued reply", {
      verbose: false,
      cfg: undefined,
      accountId: "solayre",
    });
  });

  it("skips delivery for dry-run prefixes even when the target was normalized without +", async () => {
    const sendMessageWhatsApp = vi.fn(async () => ({ messageId: "msg-1", toJid: "jid-1" }));
    const fallbackSendWebChannelMessage = vi.fn(async () => ({ messageId: "fallback" }));

    await sendLeadBotWhatsAppMessage({
      to: "00000123456",
      text: "Queued reply",
      mediaUrl: "/tmp/quote.pdf",
      accountId: "solayre",
      dryRunPrefixes: ["+00000"],
      sendMessageWhatsApp,
      fallbackSendWebChannelMessage,
    });

    expect(sendMessageWhatsApp).not.toHaveBeenCalled();
    expect(fallbackSendWebChannelMessage).not.toHaveBeenCalled();
  });
});
