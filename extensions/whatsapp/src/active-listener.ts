// Whatsapp plugin module implements active listener behavior.
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";

export type { ActiveWebListener, ActiveWebSendOptions };

// Raw message subscribers — plugins can register to receive every WAMessage.
// Backed by a globalThis Symbol so subscribers from other plugin bundles share the same Set.
// External consumer: whatsapp-lead-bot grabs this Symbol directly.
type RawMessageCallback = (accountId: string, msg: unknown) => void;
const RAW_MESSAGE_SUBSCRIBERS_KEY = Symbol.for("openclaw.whatsapp.rawMessageSubscribers");
type RawSubscribersState = { subscribers: Set<RawMessageCallback> };
const rawG = globalThis as unknown as Record<symbol, RawSubscribersState | undefined>;
if (!rawG[RAW_MESSAGE_SUBSCRIBERS_KEY]) {
  rawG[RAW_MESSAGE_SUBSCRIBERS_KEY] = { subscribers: new Set<RawMessageCallback>() };
}
const rawMessageSubscribers = rawG[RAW_MESSAGE_SUBSCRIBERS_KEY].subscribers;

export function onRawWhatsAppMessage(cb: RawMessageCallback): () => void {
  rawMessageSubscribers.add(cb);
  return () => rawMessageSubscribers.delete(cb);
}

export function emitRawWhatsAppMessage(accountId: string, msg: unknown): void {
  for (const cb of rawMessageSubscribers) {
    try {
      cb(accountId, msg);
    } catch (err) {
      console.error("[whatsapp] Raw message subscriber error:", err);
    }
  }
}

// Enriched message subscribers — fire after inbound is normalized (E.164 resolved
// from any LID mapping) and media is downloaded. Subscribers see the resolved
// peerE164 and the local mediaPath/mediaType/mediaFileName when present.
export type EnrichedWhatsAppMessage = {
  id: string;
  accountId: string;
  remoteJid: string;
  peerE164?: string; // resolved E.164 of the conversation peer (DMs only)
  fromMe: boolean;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
};
type EnrichedMessageCallback = (msg: EnrichedWhatsAppMessage) => void;
const ENRICHED_MESSAGE_SUBSCRIBERS_KEY = Symbol.for("openclaw.whatsapp.enrichedMessageSubscribers");
type EnrichedSubscribersState = { subscribers: Set<EnrichedMessageCallback> };
const enrichedG = globalThis as unknown as Record<symbol, EnrichedSubscribersState | undefined>;
if (!enrichedG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY]) {
  enrichedG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY] = { subscribers: new Set<EnrichedMessageCallback>() };
}
const enrichedMessageSubscribers = enrichedG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY].subscribers;

export function onEnrichedWhatsAppMessage(cb: EnrichedMessageCallback): () => void {
  enrichedMessageSubscribers.add(cb);
  return () => enrichedMessageSubscribers.delete(cb);
}

export function emitEnrichedWhatsAppMessage(msg: EnrichedWhatsAppMessage): void {
  for (const cb of enrichedMessageSubscribers) {
    try {
      cb(msg);
    } catch (err) {
      console.error("[whatsapp] Enriched message subscriber error:", err);
    }
  }
}

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

// Look up an active listener via the connection-controller registry. Returns
// the current authenticated listener for the given account, or null.
export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return getRegisteredWhatsAppConnectionController(id)?.getActiveListener() ?? null;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = getActiveWebListener(id);
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`,
    );
  }
  return { accountId: id, listener };
}

// Legacy fork API kept for callers (outbound.ts, auto-reply/monitor.ts).
// Listener registration is now owned by the WhatsAppConnectionController via
// the connection-controller-registry; this remains a no-op shim so callers
// migrating off the old setter compile and run.
export function setActiveWebListener(listener: ActiveWebListener | null): void;
export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void;
export function setActiveWebListener(
  _accountIdOrListener: string | ActiveWebListener | null | undefined,
  _maybeListener?: ActiveWebListener | null,
): void {
  // No-op: connection-controller-registry now owns listener registration.
  // The legacy setter is preserved for source compatibility only.
}
