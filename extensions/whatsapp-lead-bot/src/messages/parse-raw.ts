import type { StoredMessage } from "../database/schema.js";

/**
 * Parse a raw Baileys WAMessage into a StoredMessage for persistence.
 * Returns null if the message lacks required fields (id or remoteJid).
 */
export function parseRawMessage(rawMsg: {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  messageTimestamp?: number | Long;
  message?: Record<string, unknown>;
}): StoredMessage | null {
  const msgId = rawMsg?.key?.id;
  const remoteJid = rawMsg?.key?.remoteJid;
  if (!msgId || !remoteJid) {
    return null;
  }

  const fromMe = rawMsg.key!.fromMe ? 1 : 0;
  const participant = rawMsg.key!.participant ?? null;
  const ts = rawMsg.messageTimestamp
    ? Number(rawMsg.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  const msg = rawMsg.message;
  const content = extractTextContent(msg);
  const messageType = msg
    ? (Object.keys(msg).find((k) => k !== "messageContextInfo") ?? "unknown")
    : "unknown";
  const media = extractMediaMetadata(msg);

  return {
    id: msgId,
    chat_jid: remoteJid,
    sender_jid: participant,
    from_me: fromMe,
    timestamp: ts,
    content,
    message_type: messageType,
    media_type: media.mimetype,
    media_filename: media.filename,
    media_size: media.size,
    created_at: Date.now(),
  };
}

function extractMediaMetadata(msg: Record<string, unknown> | undefined): {
  mimetype: string | null;
  filename: string | null;
  size: number | null;
} {
  const empty = { mimetype: null, filename: null, size: null };
  if (!msg) {
    return empty;
  }
  const candidates = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
  ] as const;
  for (const key of candidates) {
    const m = msg[key] as Record<string, unknown> | undefined;
    if (!m) {
      continue;
    }
    const mimetype = (m.mimetype as string | undefined) ?? null;
    const filename = (m.fileName as string | undefined) ?? null;
    const lengthRaw = m.fileLength;
    let size: number | null = null;
    if (typeof lengthRaw === "number") {
      size = lengthRaw;
    } else if (lengthRaw && typeof lengthRaw === "object" && "low" in lengthRaw) {
      size = (lengthRaw as { low: number }).low;
    } else if (typeof lengthRaw === "string") {
      const parsed = Number(lengthRaw);
      size = Number.isFinite(parsed) ? parsed : null;
    }
    return { mimetype, filename, size };
  }
  return empty;
}

function extractTextContent(msg: Record<string, unknown> | undefined): string | null {
  if (!msg) {
    return null;
  }
  const ext = msg.extendedTextMessage as Record<string, unknown> | undefined;
  const img = msg.imageMessage as Record<string, unknown> | undefined;
  const vid = msg.videoMessage as Record<string, unknown> | undefined;
  const doc = msg.documentMessage as Record<string, unknown> | undefined;
  return (
    (msg.conversation as string) ??
    (ext?.text as string) ??
    (img?.caption as string) ??
    (vid?.caption as string) ??
    (doc?.caption as string) ??
    null
  );
}

type Long = { low: number; high: number; unsigned: boolean };
