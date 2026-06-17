// Session store migrations repair legacy field names during load/save normalization.
import type { SessionEntry } from "./types.js";

function resolveCanonicalTelegramDmTopicSessionKey(key: string): string | undefined {
  const parts = key.split(":");
  const threadMarkerIndex = parts.lastIndexOf("thread");
  if (threadMarkerIndex === -1 || threadMarkerIndex !== parts.length - 2) {
    return undefined;
  }
  const directIndex = parts.lastIndexOf("direct", threadMarkerIndex);
  if (directIndex === -1 || directIndex >= threadMarkerIndex - 1) {
    return undefined;
  }
  const telegramIndex = parts.indexOf("telegram");
  if (telegramIndex === -1 || telegramIndex > directIndex) {
    return undefined;
  }
  const chatId = parts[directIndex + 1];
  const threadId = parts[threadMarkerIndex + 1];
  if (!/^-?\d+$/.test(chatId) || !/^-?\d+$/.test(threadId)) {
    return undefined;
  }
  return `${parts.slice(0, threadMarkerIndex + 1).join(":")}:${chatId}:${threadId}`;
}

function migrateTelegramDmTopicSessionKeys(store: Record<string, SessionEntry>): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    const canonicalKey = resolveCanonicalTelegramDmTopicSessionKey(key);
    if (!canonicalKey || canonicalKey === key) {
      continue;
    }
    if (store[canonicalKey]) {
      continue;
    }
    store[canonicalKey] = entry;
    delete store[key];
    changed = true;
  }
  return changed;
}

export function applySessionStoreMigrations(store: Record<string, SessionEntry>): boolean {
  let changed = migrateTelegramDmTopicSessionKeys(store);
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
      changed = true;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
      changed = true;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
      changed = true;
    } else if ("room" in rec) {
      delete rec.room;
      changed = true;
    }
  }
  return changed;
}
