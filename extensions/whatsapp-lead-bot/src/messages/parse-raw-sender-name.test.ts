import { describe, expect, it } from "vitest";
import { parseRawMessage } from "./parse-raw.js";

describe("parseRawMessage sender metadata", () => {
  it("persists the WhatsApp push name as sender_name", () => {
    const stored = parseRawMessage({
      key: {
        id: "msg-1",
        remoteJid: "526679960782@s.whatsapp.net",
        fromMe: false,
      },
      pushName: " Israel Quiñonez ",
      messageTimestamp: 1780451347,
      message: { conversation: "hola" },
    });

    expect(stored?.sender_name).toBe("Israel Quiñonez");
  });
});
