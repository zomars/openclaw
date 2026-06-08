import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestedMessageRecord, JsonlIngestStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-conversation-ingest-"));
  tempDirs.push(dir);
  return new JsonlIngestStore(path.join(dir, "ingested_messages.jsonl"));
}

describe("conversation ingest store", () => {
  it("creates an archive-worthy record from message_received event/context", () => {
    const record = createIngestedMessageRecord(
      {
        from: "whatsapp:+15551234567",
        content: "Need the quote from last week",
        timestamp: 1710000000,
        messageId: "wamid.1",
        metadata: {
          to: "120363@g.us",
          senderName: "Customer One",
          mediaPath: "/tmp/quote.pdf",
          mediaType: "application/pdf",
        },
      },
      {
        channelId: "whatsapp",
        accountId: "solayre",
        conversationId: "120363@g.us",
        messageId: "wamid.1",
        senderId: "+15551234567",
      },
      new Date("2026-05-23T17:00:00.000Z"),
    );

    expect(record).toMatchObject({
      channelId: "whatsapp",
      accountId: "solayre",
      conversationId: "120363@g.us",
      from: "whatsapp:+15551234567",
      content: "Need the quote from last week",
      timestampIso: "2024-03-09T16:00:00.000Z",
      mediaPath: "/tmp/quote.pdf",
      mediaType: "application/pdf",
    });
    expect(record?.raw.event.metadata?.senderName).toBe("Customer One");
  });

  it("ignores empty messages with no media refs", () => {
    expect(
      createIngestedMessageRecord(
        { from: "telegram:1", content: "   " },
        { channelId: "telegram" },
      ),
    ).toBeNull();
  });

  it("searches recent archived messages by query, chat, account, and channel", async () => {
    const store = await tempStore();
    const first = createIngestedMessageRecord(
      { from: "whatsapp:+1", content: "solar quote approved", timestamp: 1710000000 },
      { channelId: "whatsapp", accountId: "solayre", conversationId: "chat-1" },
    );
    const second = createIngestedMessageRecord(
      { from: "telegram:2", content: "unrelated note", timestamp: 1710000100 },
      { channelId: "telegram", accountId: "default", conversationId: "chat-2" },
    );
    if (!first || !second) {
      throw new Error("expected records");
    }
    await store.append(first);
    await store.append(second);

    await expect(
      store.search({ query: "quote", chat: "chat-1", account: "solayre", channel: "whatsapp" }),
    ).resolves.toMatchObject({
      count: 1,
      messages: [
        {
          channel: "whatsapp",
          account: "solayre",
          chat: "chat-1",
          content: "solar quote approved",
        },
      ],
    });
  });
});
