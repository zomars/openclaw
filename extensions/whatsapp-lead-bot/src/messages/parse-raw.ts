import type { StoredMessage } from "../database/schema.js";

/**
 * Parse a raw Baileys WAMessage into a StoredMessage for persistence.
 * Returns null if the message lacks required fields (id or remoteJid).
 */
export function parseRawMessage(rawMsg: {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  pushName?: string | null;
  senderName?: string | null;
  notifyName?: string | null;
  verifiedBizName?: string | null;
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
  const messageType = msg
    ? (Object.keys(msg).find((k) => k !== "messageContextInfo") ?? "unknown")
    : "unknown";
  let content = extractTextContent(msg);
  const media = extractMediaMetadata(msg);
  const reaction = extractReaction(msg);
  const protoEvent = extractProtocolEvent(msg);

  // Edits carry the new content inside protocolMessage.editedMessage; surface it.
  if (protoEvent.editedFromId && protoEvent.editedNewContent) {
    content = protoEvent.editedNewContent;
  }

  return {
    id: msgId,
    chat_jid: remoteJid,
    sender_jid: participant,
    sender_name: normalizeName(
      rawMsg.pushName ?? rawMsg.senderName ?? rawMsg.notifyName ?? rawMsg.verifiedBizName,
    ),
    from_me: fromMe,
    timestamp: ts,
    content,
    message_type: messageType,
    media_type: media.mimetype,
    media_filename: media.filename,
    media_size: media.size,
    media_path: null,
    reaction_emoji: reaction.emoji,
    reaction_target_id: reaction.targetId,
    revoked_target_id: protoEvent.revokedTargetId,
    edited_from_id: protoEvent.editedFromId,
    peer_e164: null,
    created_at: Date.now(),
  };
}

function extractReaction(msg: Record<string, unknown> | undefined): {
  emoji: string | null;
  targetId: string | null;
} {
  if (!msg) {
    return { emoji: null, targetId: null };
  }
  const r = msg.reactionMessage as { text?: string; key?: { id?: string } } | undefined;
  if (!r) {
    return { emoji: null, targetId: null };
  }
  return { emoji: r.text ?? null, targetId: r.key?.id ?? null };
}

function extractProtocolEvent(msg: Record<string, unknown> | undefined): {
  revokedTargetId: string | null;
  editedFromId: string | null;
  editedNewContent: string | null;
} {
  const empty = { revokedTargetId: null, editedFromId: null, editedNewContent: null };
  if (!msg) {
    return empty;
  }
  const p = msg.protocolMessage as
    | {
        type?: number | string;
        key?: { id?: string };
        editedMessage?: Record<string, unknown>;
      }
    | undefined;
  if (!p) {
    return empty;
  }
  // Baileys proto: REVOKE = 0, MESSAGE_EDIT = 14 (varies by version; also accept string forms)
  const isRevoke = p.type === 0 || p.type === "REVOKE";
  const isEdit = p.type === 14 || p.type === "MESSAGE_EDIT" || Boolean(p.editedMessage);
  if (isRevoke) {
    return { ...empty, revokedTargetId: p.key?.id ?? null };
  }
  if (isEdit) {
    return {
      revokedTargetId: null,
      editedFromId: p.key?.id ?? null,
      editedNewContent: p.editedMessage ? extractTextContent(p.editedMessage) : null,
    };
  }
  return empty;
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

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
