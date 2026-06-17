// Whatsapp type declarations define plugin contracts.
import type { AnyMessageContent, MiscMessageGenerationOptions } from "baileys";
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import type { PollInput } from "openclaw/plugin-sdk/poll-runtime";
import type { WhatsAppIdentity, WhatsAppReplyContext, WhatsAppSelfIdentity } from "../identity.js";
import type { WhatsAppSendResult } from "./send-result.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type ActiveWebSendOptions = {
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
  asDocument?: boolean;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<WhatsAppSendResult>;
  sendPoll: (to: string, poll: PollInput) => Promise<WhatsAppSendResult>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<WhatsAppSendResult>;
  sendComposingTo: (to: string) => Promise<void>;
  // Fork-specific: label management surface used by outbound.ts and
  // whatsapp-lead-bot for chat tagging/lifecycle.
  addChatLabel?: (chatJid: string, labelId: string) => Promise<void>;
  removeChatLabel?: (chatJid: string, labelId: string) => Promise<void>;
  getLabels?: () => Promise<
    { id: string; name: string; color: number; deleted: boolean; predefinedId?: string }[]
  >;
  createLabel?: (
    name: string,
    color: number,
  ) => Promise<{ id: string; name: string; color: number } | undefined>;
  addLabel?: (
    jid: string,
    labels: { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number },
  ) => Promise<void>;
  addMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
  removeMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
  onWhatsApp?: (
    ...phoneNumbers: string[]
  ) => Promise<{ jid: string; exists: boolean }[] | undefined>;
  getBusinessProfile?: (jid: string) => Promise<unknown>;
  fetchStatus?: (...jids: string[]) => Promise<unknown>;
  chatModify?: (mod: unknown, jid: string) => Promise<void>;
  fetchBlocklist?: () => Promise<(string | undefined)[]>;
  profilePictureUrl?: (
    jid: string,
    type?: "preview" | "image",
    timeoutMs?: number,
  ) => Promise<string | undefined>;
  groupMetadata?: (jid: string) => Promise<unknown>;
  readMessages?: (keys: unknown[]) => Promise<void>;
  star?: (
    jid: string,
    messages: { id: string; fromMe?: boolean }[],
    star: boolean,
  ) => Promise<void>;
  fetchMessageHistory?: (
    count: number,
    oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string },
    oldestMsgTimestamp: number,
  ) => Promise<string>;
  close?: () => Promise<void>;
};

export type WhatsAppStructuredContactContext = {
  kind: "contact" | "contacts";
  total: number;
  contacts: Array<{
    name?: string;
    phones?: string[];
  }>;
};

export type WhatsAppInboundEvent = {
  id?: string;
  timestamp?: number;
  isBatched?: boolean;
};

export type WhatsAppInboundQuote = {
  context?: WhatsAppReplyContext;
  id?: string;
  body?: string;
  sender?: {
    displayName?: string;
    jid?: string;
    e164?: string;
  };
};

export type WhatsAppInboundGroupContext = {
  subject?: string;
  participants?: string[];
  mentions?: {
    text?: string[];
    jids?: string[];
  };
};

export type WhatsAppInboundPayload = {
  body: string;
  media?: {
    path?: string;
    type?: string;
    fileName?: string;
    url?: string;
  };
  location?: NormalizedLocation;
  untrustedStructuredContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
};

export type WhatsAppInboundPlatform = {
  chatJid: string;
  recipientJid: string;
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  pushName?: string;
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  // Fork-specific: true when the message was sent by the account owner via
  // WhatsApp Web (fromMe: true). Routed through inbound for handoff detection.
  isAccountOwnerMessage?: boolean;
  sendComposing: () => Promise<void>;
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  sendMedia: (
    payload: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WhatsAppSendResult>;
};

export type DeprecatedWebInboundMessageFlatAliases = {
  /** @deprecated Use `event.id`. */
  id?: string;
  /** @deprecated Use `platform.recipientJid`. */
  to: string;
  /** @deprecated Use `payload.body`. */
  body: string;
  /** @deprecated Use `platform.pushName`. */
  pushName?: string;
  /** @deprecated Use `event.timestamp`. */
  timestamp?: number;
  /** @deprecated Use `platform.chatJid`. */
  chatId: string;
  /** @deprecated Use `platform.sender`. */
  sender?: WhatsAppIdentity;
  /** @deprecated Use `platform.senderJid`. */
  senderJid?: string;
  /** @deprecated Use `platform.senderE164`. */
  senderE164?: string;
  /** @deprecated Use `platform.senderName`. */
  senderName?: string;
  /** @deprecated Use `quote.context`. */
  replyTo?: WhatsAppReplyContext;
  /** @deprecated Use `quote.id`. */
  replyToId?: string;
  /** @deprecated Use `quote.body`. */
  replyToBody?: string;
  /** @deprecated Use `quote.sender.displayName`. */
  replyToSender?: string;
  /** @deprecated Use `quote.sender.jid`. */
  replyToSenderJid?: string;
  /** @deprecated Use `quote.sender.e164`. */
  replyToSenderE164?: string;
  /** @deprecated Use `group.subject`. */
  groupSubject?: string;
  /** @deprecated Use `group.participants`. */
  groupParticipants?: string[];
  /** @deprecated Use `group.mentions.jids`. */
  mentions?: string[];
  /** @deprecated Use `group.mentions.jids`. */
  mentionedJids?: string[];
  /** @deprecated Use `platform.self`. */
  self?: WhatsAppSelfIdentity;
  /** @deprecated Use `platform.selfJid`. */
  selfJid?: string | null;
  /** @deprecated Use `platform.selfLid`. */
  selfLid?: string | null;
  /** @deprecated Use `platform.selfE164`. */
  selfE164?: string | null;
  /** @deprecated Use `platform.fromMe`. */
  fromMe?: boolean;
  /** Fork-specific: true when sent by account owner via WhatsApp Web. */
  isAccountOwnerMessage?: boolean;
  /** Fork-specific: Click-to-WhatsApp ad context identifier. */
  ctwaClid?: string;
  /** @deprecated Use `payload.location`. */
  location?: NormalizedLocation;
  /** @deprecated Use `platform.sendComposing`. */
  sendComposing: () => Promise<void>;
  /** @deprecated Use `platform.reply`. */
  reply: (text: string, options?: MiscMessageGenerationOptions) => Promise<WhatsAppSendResult>;
  /** @deprecated Use `platform.sendMedia`. */
  sendMedia: (
    payload: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WhatsAppSendResult>;
  /** @deprecated Use `payload.media.path`. */
  mediaPath?: string;
  /** @deprecated Use `payload.media.type`. */
  mediaType?: string;
  /** @deprecated Use `payload.media.fileName`. */
  mediaFileName?: string;
  /** @deprecated Use `payload.media.url`. */
  mediaUrl?: string;
  /** @deprecated Use `payload.untrustedStructuredContext`. */
  untrustedStructuredContext?: Array<{
    label: string;
    source?: string;
    type?: string;
    payload: unknown;
  }>;
  /** @deprecated Use `event.isBatched`. */
  isBatched?: boolean;
};

type WebInboundMessageCommon = {
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  accountId: string;
  /** Set by the real inbound monitor after access-control / pairing checks pass. */
  accessControlPassed?: boolean;
  chatType: "direct" | "group";
  quote?: WhatsAppInboundQuote;
  group?: WhatsAppInboundGroupContext;
  wasMentioned?: boolean;
};

export type WebInboundCallbackMessage = WebInboundMessageCommon & {
  event: WhatsAppInboundEvent;
  payload: WhatsAppInboundPayload;
  platform: WhatsAppInboundPlatform;
};

export type WebInboundMessage = WebInboundCallbackMessage & DeprecatedWebInboundMessageFlatAliases;

export type LegacyFlatWebInboundMessage = WebInboundMessageCommon &
  DeprecatedWebInboundMessageFlatAliases & {
    event?: never;
    payload?: never;
    platform?: never;
    quote?: never;
    group?: never;
  };

export type WebInboundMessageInput = LegacyFlatWebInboundMessage | WebInboundCallbackMessage;
