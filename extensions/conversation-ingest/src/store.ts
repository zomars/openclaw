import { createHash } from "node:crypto";
import fs from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type MessageReceivedLike = {
  from: string;
  content?: string;
  timestamp?: number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
};

export type MessageContextLike = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
};

export type IngestedMessageRecord = {
  id: string;
  archivedAt: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
  from: string;
  to?: string;
  content: string;
  timestamp?: number;
  timestampIso?: string;
  threadId?: string | number;
  mediaPath?: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  metadata?: Record<string, unknown>;
  raw: {
    event: MessageReceivedLike;
    context: MessageContextLike;
  };
};

export type SearchIngestedMessagesParams = {
  query?: string;
  chat?: string;
  account?: string;
  channel?: string;
  limit?: number;
};

export type SearchIngestedMessagesResult = {
  path: string;
  count: number;
  messages: Array<{
    id: string;
    timestamp_iso?: string;
    channel: string;
    account?: string;
    chat?: string;
    from: string;
    content: string;
    message_id?: string;
    media?: {
      path?: string;
      url?: string;
      type?: string;
      paths?: string[];
      urls?: string[];
      types?: string[];
    };
  }>;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function timestampIso(timestamp: number | undefined): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return undefined;
  }
  const millis = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(millis).toISOString();
}

function stableRecordId(record: Omit<IngestedMessageRecord, "id">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId: record.channelId,
        accountId: record.accountId,
        conversationId: record.conversationId,
        messageId: record.messageId,
        from: record.from,
        timestamp: record.timestamp,
        content: record.content,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export function defaultIngestPath(stateDir: string): string {
  return path.join(stateDir, "conversation-ingest", "ingested_messages.jsonl");
}

export function createIngestedMessageRecord(
  event: MessageReceivedLike,
  context: MessageContextLike,
  archivedAt = new Date(),
): IngestedMessageRecord | null {
  const metadata = event.metadata;
  const content = event.content ?? "";
  const hasMedia = Boolean(
    metadataString(metadata, "mediaPath") ??
    metadataString(metadata, "mediaUrl") ??
    metadataString(metadata, "mediaType") ??
    metadataStringArray(metadata, "mediaPaths") ??
    metadataStringArray(metadata, "mediaUrls") ??
    metadataStringArray(metadata, "mediaTypes"),
  );
  if (content.trim().length === 0 && !hasMedia) {
    return null;
  }

  const base: Omit<IngestedMessageRecord, "id"> = {
    archivedAt: archivedAt.toISOString(),
    channelId: context.channelId,
    accountId: context.accountId,
    conversationId: context.conversationId,
    sessionKey: context.sessionKey ?? event.sessionKey,
    messageId: context.messageId ?? event.messageId,
    senderId: context.senderId ?? event.senderId,
    from: event.from,
    to: metadataString(metadata, "to"),
    content,
    timestamp: event.timestamp,
    timestampIso: timestampIso(event.timestamp),
    threadId: event.threadId,
    mediaPath: metadataString(metadata, "mediaPath"),
    mediaUrl: metadataString(metadata, "mediaUrl"),
    mediaType: metadataString(metadata, "mediaType"),
    mediaPaths: metadataStringArray(metadata, "mediaPaths"),
    mediaUrls: metadataStringArray(metadata, "mediaUrls"),
    mediaTypes: metadataStringArray(metadata, "mediaTypes"),
    metadata,
    raw: { event, context },
  };
  return { id: stableRecordId(base), ...base };
}

export class JsonlIngestStore {
  constructor(readonly filePath: string) {}

  async append(record: IngestedMessageRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async search(params: SearchIngestedMessagesParams = {}): Promise<SearchIngestedMessagesResult> {
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    if (!fs.existsSync(this.filePath)) {
      return { path: this.filePath, count: 0, messages: [] };
    }

    const query = params.query?.trim().toLowerCase();
    const chat = params.chat?.trim().toLowerCase();
    const account = params.account?.trim().toLowerCase();
    const channel = params.channel?.trim().toLowerCase();
    const lines = (await readFile(this.filePath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const matches: IngestedMessageRecord[] = [];

    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
      const parsed = parseRecord(lines[i]);
      if (!parsed) {
        continue;
      }
      if (channel && parsed.channelId.toLowerCase() !== channel) {
        continue;
      }
      if (account && (parsed.accountId ?? "").toLowerCase() !== account) {
        continue;
      }
      if (chat) {
        const haystack = [parsed.conversationId, parsed.from, parsed.to, parsed.sessionKey]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(chat)) {
          continue;
        }
      }
      if (query) {
        const haystack = [
          parsed.content,
          parsed.from,
          parsed.to,
          parsed.conversationId,
          parsed.senderId,
          parsed.metadata?.senderName,
          parsed.metadata?.senderUsername,
          parsed.metadata?.topicName,
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
      }
      matches.push(parsed);
    }

    matches.reverse();
    return {
      path: this.filePath,
      count: matches.length,
      messages: matches.map((record) => ({
        id: record.id,
        timestamp_iso: record.timestampIso,
        channel: record.channelId,
        account: record.accountId,
        chat: record.conversationId,
        from: record.from,
        content: record.content,
        message_id: record.messageId,
        media:
          record.mediaPath ||
          record.mediaUrl ||
          record.mediaType ||
          record.mediaPaths ||
          record.mediaUrls ||
          record.mediaTypes
            ? {
                path: record.mediaPath,
                url: record.mediaUrl,
                type: record.mediaType,
                paths: record.mediaPaths,
                urls: record.mediaUrls,
                types: record.mediaTypes,
              }
            : undefined,
      })),
    };
  }
}

function parseRecord(line: string): IngestedMessageRecord | null {
  try {
    const value = JSON.parse(line) as Partial<IngestedMessageRecord>;
    if (
      typeof value.id !== "string" ||
      typeof value.channelId !== "string" ||
      typeof value.from !== "string" ||
      typeof value.content !== "string"
    ) {
      return null;
    }
    return value as IngestedMessageRecord;
  } catch {
    return null;
  }
}
