/**
 * PROTOTYPE - wipe me.
 *
 * Question: can the base WhatsApp channel own a complete-enough history stream
 * by combining Baileys upserts with deterministic outbound writes, so business
 * plugins such as whatsapp-lead-bot only query history instead of capturing it?
 */

export type CaptureSource =
  | "baileys-upsert"
  | "enriched-upsert"
  | "deterministic-outbound"
  | "history-sync";

export type Direction = "inbound" | "outbound";

export interface CapturedMessage {
  accountId: string;
  chatJid: string;
  messageId: string;
  peerE164: string | null;
  direction: Direction;
  fromMe: boolean;
  body: string;
  timestampMs: number;
  sources: CaptureSource[];
  mediaPath?: string;
}

export interface CaptureState {
  messages: CapturedMessage[];
  notes: string[];
  nowMs: number;
}

export type CaptureAction =
  | {
      type: "baileys-upsert";
      accountId: string;
      chatJid: string;
      messageId: string;
      peerE164?: string;
      fromMe: boolean;
      body: string;
      timestampMs?: number;
    }
  | {
      type: "enriched-upsert";
      accountId: string;
      chatJid: string;
      messageId: string;
      peerE164?: string;
      mediaPath?: string;
    }
  | {
      type: "deterministic-outbound";
      accountId: string;
      chatJid: string;
      messageId: string;
      peerE164?: string;
      body: string;
      timestampMs?: number;
    }
  | {
      type: "history-sync";
      accountId: string;
      chatJid: string;
      messageId: string;
      peerE164?: string;
      fromMe: boolean;
      body: string;
      timestampMs?: number;
    }
  | { type: "tick" }
  | { type: "reset" };

export function createInitialCaptureState(): CaptureState {
  return {
    messages: [],
    notes: [
      "Base WhatsApp channel owns storage.",
      "Business plugins query history and do not subscribe to raw message events.",
    ],
    nowMs: Date.parse("2026-06-23T18:00:00.000Z"),
  };
}

export function reduceCaptureState(state: CaptureState, action: CaptureAction): CaptureState {
  if (action.type === "reset") {
    return createInitialCaptureState();
  }
  if (action.type === "tick") {
    return { ...state, nowMs: state.nowMs + 60_000 };
  }

  const timestampMs =
    "timestampMs" in action && action.timestampMs ? action.timestampMs : state.nowMs;
  const direction =
    action.type === "deterministic-outbound" || ("fromMe" in action && action.fromMe)
      ? "outbound"
      : "inbound";
  const source = sourceForAction(action.type);
  const existing = state.messages.find(
    (message) =>
      message.accountId === action.accountId &&
      message.chatJid === action.chatJid &&
      message.messageId === action.messageId,
  );

  const messages = existing
    ? state.messages.map((message) =>
        message === existing
          ? mergeMessage(message, action, source, timestampMs, direction)
          : message,
      )
    : [...state.messages, createMessageFromAction(action, source, timestampMs, direction)];

  return {
    ...state,
    messages: messages.sort(
      (a, b) => a.timestampMs - b.timestampMs || a.messageId.localeCompare(b.messageId),
    ),
  };
}

export function queryByPeer(state: CaptureState, peerE164: string): CapturedMessage[] {
  const normalized = normalizeE164(peerE164);
  return state.messages.filter((message) => normalizeE164(message.peerE164 ?? "") === normalized);
}

export function summarizeState(state: CaptureState): {
  total: number;
  inbound: number;
  outbound: number;
  deterministicOutbound: number;
  withPeerE164: number;
  withMedia: number;
} {
  return {
    total: state.messages.length,
    inbound: state.messages.filter((message) => message.direction === "inbound").length,
    outbound: state.messages.filter((message) => message.direction === "outbound").length,
    deterministicOutbound: state.messages.filter((message) =>
      message.sources.includes("deterministic-outbound"),
    ).length,
    withPeerE164: state.messages.filter((message) => Boolean(message.peerE164)).length,
    withMedia: state.messages.filter((message) => Boolean(message.mediaPath)).length,
  };
}

export function messagesMissingIfRawOnly(state: CaptureState): CapturedMessage[] {
  return state.messages.filter(
    (message) =>
      message.sources.includes("deterministic-outbound") &&
      !message.sources.includes("baileys-upsert"),
  );
}

function sourceForAction(type: CaptureAction["type"]): CaptureSource {
  switch (type) {
    case "baileys-upsert":
      return "baileys-upsert";
    case "enriched-upsert":
      return "enriched-upsert";
    case "deterministic-outbound":
      return "deterministic-outbound";
    case "history-sync":
      return "history-sync";
    default:
      throw new Error(`Unsupported capture action: ${type}`);
  }
}

function createMessageFromAction(
  action: Exclude<CaptureAction, { type: "reset" | "tick" }>,
  source: CaptureSource,
  timestampMs: number,
  direction: Direction,
): CapturedMessage {
  return {
    accountId: action.accountId,
    chatJid: action.chatJid,
    messageId: action.messageId,
    peerE164: "peerE164" in action ? (action.peerE164 ?? null) : null,
    direction,
    fromMe: direction === "outbound",
    body: "body" in action ? action.body : "",
    timestampMs,
    sources: [source],
    mediaPath: "mediaPath" in action ? action.mediaPath : undefined,
  };
}

function mergeMessage(
  message: CapturedMessage,
  action: Exclude<CaptureAction, { type: "reset" | "tick" }>,
  source: CaptureSource,
  timestampMs: number,
  direction: Direction,
): CapturedMessage {
  return {
    ...message,
    peerE164: ("peerE164" in action ? action.peerE164 : undefined) ?? message.peerE164,
    direction:
      message.direction === "outbound" || direction === "outbound" ? "outbound" : "inbound",
    fromMe: message.fromMe || direction === "outbound",
    body: "body" in action && action.body ? action.body : message.body,
    timestampMs: Math.min(message.timestampMs, timestampMs),
    mediaPath: ("mediaPath" in action ? action.mediaPath : undefined) ?? message.mediaPath,
    sources: addUnique(message.sources, source),
  };
}

function normalizeE164(value: string): string {
  return value.replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1");
}

function addUnique<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values : [...values, value];
}
