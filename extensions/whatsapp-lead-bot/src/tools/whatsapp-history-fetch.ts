/**
 * Tool: whatsapp_history_fetch
 *
 * Returns the WhatsApp DM history for a peer. Useful when the auto-injected
 * inbound history isn't enough — e.g. when a coworker asks about a different
 * peer than the one currently messaging, or wants to look back further than
 * the auto-inject window.
 */

import type { Database } from "../database.js";
import { normalizePhone } from "../utils/phone.js";

export const whatsappHistoryFetchTool = {
  name: "whatsapp_history_fetch",
  description:
    "Fetch stored WhatsApp DM history for a peer. Returns oldest-first messages with sender, body, timestamp, and any media metadata. Use when you need conversation context for a peer other than the current sender.",
  inputSchema: {
    type: "object" as const,
    properties: {
      peer: {
        type: "string" as const,
        description: "Peer identifier — E.164 (with or without +) or full WhatsApp JID.",
      },
      limit: {
        type: "number" as const,
        description: "Max messages to return (default 100, oldest-first).",
      },
      since_iso: {
        type: "string" as const,
        description: "Optional ISO timestamp; only return messages at or after this time.",
      },
    },
    required: ["peer"],
  },
  execute: async (
    params: { peer: string; limit?: number; since_iso?: string },
    context: { db: Database },
  ) => {
    const resolved = resolvePeerLookup(params.peer);
    if (!resolved) {
      return { success: false, error: "Invalid peer; expected E.164 or JID." };
    }
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));

    // Prefer E.164 lookup (LID-aware: matches both @s.whatsapp.net and @lid rows
    // once peer_e164 has been backfilled by the enriched event).
    let rows = resolved.peerE164
      ? context.db.getMessagesByPeerE164Sync(resolved.peerE164, limit)
      : [];
    if (rows.length === 0 && resolved.peerJid) {
      rows = context.db.getMessagesSync(resolved.peerJid, limit);
    }
    if (params.since_iso) {
      const sinceMs = Date.parse(params.since_iso);
      if (Number.isFinite(sinceMs)) {
        const sinceSec = Math.floor(sinceMs / 1000);
        rows = rows.filter((r) => r.timestamp >= sinceSec);
      }
    }
    return {
      success: true,
      peer_jid: resolved.peerJid ?? null,
      peer_e164: resolved.peerE164 ?? null,
      count: rows.length,
      messages: rows.map((r) => ({
        id: r.id,
        timestamp_iso: new Date(r.timestamp * 1000).toISOString(),
        sender: r.from_me === 1 ? "me" : (r.sender_jid ?? r.chat_jid),
        from_me: r.from_me === 1,
        content: r.content,
        message_type: r.message_type,
        media_type: r.media_type,
        media_filename: r.media_filename,
        media_size: r.media_size,
        media_path: r.media_path,
      })),
    };
  },
};

function resolvePeerLookup(
  peer: string,
): { peerE164: string | null; peerJid: string | null } | null {
  const trimmed = peer.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("@")) {
    // Caller passed a JID. If it's @s.whatsapp.net we can also derive the E.164.
    if (trimmed.endsWith("@s.whatsapp.net")) {
      const digits = trimmed.split("@")[0];
      if (/^\d+$/.test(digits)) {
        return { peerE164: `+${digits}`, peerJid: trimmed };
      }
    }
    return { peerE164: null, peerJid: trimmed };
  }
  const normalized = normalizePhone(trimmed);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return { peerE164: `+${normalized}`, peerJid: `${normalized}@s.whatsapp.net` };
}
