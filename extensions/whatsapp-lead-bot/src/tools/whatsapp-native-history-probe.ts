/**
 * Tool: whatsapp_native_history_probe
 *
 * PROTOTYPE - wipe me.
 *
 * Runs inside the live gateway process so it can use the active WhatsApp
 * connection-controller registry and call Baileys fetchMessageHistory on the
 * already-connected socket. This is only a feedback-loop probe for validating
 * native history/backfill behavior.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fetchWebChannelMessageHistory } from "../../../../src/plugins/runtime/runtime-web-channel-plugin.js";
import type { Database } from "../database.js";

type NativeHistoryProbeParams = {
  accountId?: string;
  peer?: string;
  oldestId?: string;
  oldestTs?: number;
  oldestFromMe?: boolean;
  requestCount?: number;
  listenMs?: number;
  out?: string;
};

type CapturedMessage = {
  source: "messaging-history.set" | "messages.upsert";
  remoteJid: string | null;
  id: string | null;
  fromMe: boolean | null;
  timestamp: number | null;
  text: string | null;
  messageType: string | null;
};

type ProbeAnchor = {
  peer: string;
  oldestId: string;
  oldestTs: number;
  oldestFromMe: boolean;
  localCount?: number;
  localLastTs?: number;
};

type EventEmitterLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type WhatsAppSocketLike = {
  ev?: EventEmitterLike;
  user?: unknown;
  fetchMessageHistory?: (
    count: number,
    oldestMsgKey: { remoteJid: string; id: string; fromMe: boolean },
    oldestMsgTimestamp: number,
  ) => Promise<unknown>;
};

type ControllerLike = {
  getCurrentSock?: () => WhatsAppSocketLike | null;
  getSelfIdentity?: () => unknown;
};

type RegistryState = {
  controllers?: Map<string, ControllerLike>;
};

export const whatsappNativeHistoryProbeTool = {
  name: "whatsapp_native_history_probe",
  description:
    "PROTOTYPE: call native Baileys fetchMessageHistory through the live WhatsApp gateway socket and write captured history events to an artifact.",
  inputSchema: {
    type: "object" as const,
    properties: {
      accountId: {
        type: "string" as const,
        description: "WhatsApp account id to probe. Default: solayre.",
      },
      peer: {
        type: "string" as const,
        description:
          "Conversation JID or phone. If omitted, the oldest local stored WhatsApp conversation is used as the anchor.",
      },
      oldestId: {
        type: "string" as const,
        description:
          "Oldest known message id to page before. If omitted, uses the local oldest row.",
      },
      oldestTs: {
        type: "number" as const,
        description:
          "Oldest known message timestamp, epoch seconds. If omitted, uses the local oldest row.",
      },
      oldestFromMe: {
        type: "boolean" as const,
        description: "Whether the anchor message was sent by the account owner. Default: false.",
      },
      requestCount: {
        type: "number" as const,
        description: "Number of older messages to request. Default: 50.",
      },
      listenMs: {
        type: "number" as const,
        description:
          "How long to listen for history/upsert events after the request. Default: 15000.",
      },
      out: {
        type: "string" as const,
        description: "Optional artifact path. Defaults to /tmp/openclaw/artifacts.",
      },
    },
    required: [] as string[],
  },
  execute: async (params: NativeHistoryProbeParams, context: { db: Database }) => {
    const accountId = (params.accountId ?? "solayre").trim() || "solayre";
    const requestCount = clampInteger(params.requestCount ?? 50, 1, 500);
    const listenMs = clampInteger(params.listenMs ?? 15_000, 1_000, 120_000);
    const anchor = resolveAnchor(params, context.db);

    if (!anchor) {
      return {
        success: false,
        error:
          "No anchor available. Pass peer + oldestId + oldestTs or ensure local messages exist.",
      };
    }

    const registry = getRegistry();
    const controller = registry?.controllers?.get(accountId) ?? null;
    const sock = controller?.getCurrentSock?.() ?? null;
    const captured: CapturedMessage[] = [];
    const artifactPath =
      params.out ??
      path.join(
        "/tmp/openclaw/artifacts",
        `whatsapp-native-history-probe-${safeName(accountId)}-${safeName(anchor.peer)}-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.json`,
      );

    const historyHandler = (event: unknown) => {
      const messages = readMessagesArray(event);
      for (const message of messages) {
        maybeCapture(captured, "messaging-history.set", anchor.peer, message);
      }
    };
    const upsertHandler = (event: unknown) => {
      const messages = readMessagesArray(event);
      for (const message of messages) {
        maybeCapture(captured, "messages.upsert", anchor.peer, message);
      }
    };

    const canCaptureSocketEvents = Boolean(sock?.ev);
    if (sock?.ev) {
      sock.ev.on("messaging-history.set", historyHandler);
      sock.ev.on("messages.upsert", upsertHandler);
    }

    let fetchResult: unknown;
    let fetchError: string | null = null;
    let fetchPath: "runtime-web-channel" | "registry-socket" | "none" = "none";
    try {
      const oldestMsgKey = {
        remoteJid: anchor.peer,
        id: anchor.oldestId,
        fromMe: anchor.oldestFromMe,
      };
      try {
        fetchPath = "runtime-web-channel";
        fetchResult = await fetchWebChannelMessageHistory(
          requestCount,
          oldestMsgKey,
          anchor.oldestTs,
          { accountId },
        );
      } catch (runtimeErr) {
        if (typeof sock?.fetchMessageHistory !== "function") {
          throw runtimeErr;
        }
        fetchPath = "registry-socket";
        fetchResult = await sock.fetchMessageHistory(requestCount, oldestMsgKey, anchor.oldestTs);
      }
      await delay(listenMs);
    } catch (err) {
      fetchError = err instanceof Error ? (err.stack ?? err.message) : String(err);
    } finally {
      if (sock?.ev) {
        detach(sock.ev, "messaging-history.set", historyHandler);
        detach(sock.ev, "messages.upsert", upsertHandler);
      }
    }

    const result = {
      success: fetchError === null,
      accountId,
      anchor,
      requestCount,
      listenMs,
      fetchPath,
      fetchResult: summarizeValue(fetchResult),
      fetchError,
      canCaptureSocketEvents,
      capturedCount: captured.length,
      captured,
      artifactPath,
      registryAvailable: Boolean(registry?.controllers),
      accounts: registry?.controllers ? [...registry.controllers.keys()] : [],
      selfIdentity: summarizeValue(controller?.getSelfIdentity?.() ?? null),
    };
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    return result;
  },
};

function getRegistry(): RegistryState | null {
  const key = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");
  return ((globalThis as unknown as Record<symbol, RegistryState | undefined>)[key] ??
    null) as RegistryState | null;
}

function resolveAnchor(params: NativeHistoryProbeParams, db: Database): ProbeAnchor | null {
  if (params.peer && params.oldestId && typeof params.oldestTs === "number") {
    return {
      peer: toJid(params.peer),
      oldestId: params.oldestId,
      oldestTs: params.oldestTs,
      oldestFromMe: params.oldestFromMe ?? false,
    };
  }
  return getOldestLocalAnchor(db);
}

function getOldestLocalAnchor(db: Database): ProbeAnchor | null {
  const rawDb = (
    db as unknown as {
      db?: {
        prepare: (sql: string) => {
          get: () => unknown;
        };
      };
    }
  ).db;
  const row = rawDb
    ?.prepare(
      `
      SELECT chat_jid, peer_e164, COUNT(*) AS local_count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
      FROM messages
      GROUP BY chat_jid, COALESCE(peer_e164, '')
      ORDER BY first_ts ASC
      LIMIT 1
    `,
    )
    .get() as
    | {
        chat_jid?: string;
        peer_e164?: string | null;
        local_count?: number;
        first_ts?: number;
        last_ts?: number;
      }
    | undefined;
  if (!row?.chat_jid || typeof row.first_ts !== "number") {
    return null;
  }
  const oldest = db.getMessagesSync(row.chat_jid, 1)[0];
  if (!oldest?.id) {
    return null;
  }
  return {
    peer: row.chat_jid,
    oldestId: oldest.id,
    oldestTs: oldest.timestamp,
    oldestFromMe: oldest.from_me === 1,
    localCount: row.local_count,
    localLastTs: row.last_ts,
  };
}

function toJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function readMessagesArray(event: unknown): unknown[] {
  if (
    event &&
    typeof event === "object" &&
    Array.isArray((event as { messages?: unknown }).messages)
  ) {
    return (event as { messages: unknown[] }).messages;
  }
  return [];
}

function maybeCapture(
  rows: CapturedMessage[],
  source: CapturedMessage["source"],
  peer: string,
  message: unknown,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const key = (
    message as { key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null } }
  ).key;
  if (key?.remoteJid !== peer) {
    return;
  }
  const payload = (message as { message?: Record<string, unknown> | null }).message ?? undefined;
  rows.push({
    source,
    remoteJid: key.remoteJid ?? null,
    id: key.id ?? null,
    fromMe: key.fromMe ?? null,
    timestamp: normalizeTimestamp((message as { messageTimestamp?: unknown }).messageTimestamp),
    text: extractText(payload),
    messageType: payload
      ? (Object.keys(payload).find((name) => name !== "messageContextInfo") ?? null)
      : null,
  });
}

function extractText(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const ext = message.extendedTextMessage as Record<string, unknown> | undefined;
  const img = message.imageMessage as Record<string, unknown> | undefined;
  const vid = message.videoMessage as Record<string, unknown> | undefined;
  const doc = message.documentMessage as Record<string, unknown> | undefined;
  return (
    (message.conversation as string | undefined) ??
    (ext?.text as string | undefined) ??
    (img?.caption as string | undefined) ??
    (vid?.caption as string | undefined) ??
    (doc?.caption as string | undefined) ??
    null
  );
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (
    value &&
    typeof value === "object" &&
    "low" in value &&
    typeof (value as { low: unknown }).low === "number"
  ) {
    return (value as { low: number }).low;
  }
  return null;
}

function detach(emitter: EventEmitterLike, event: string, listener: (...args: unknown[]) => void) {
  if (typeof emitter.off === "function") {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96);
}

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
