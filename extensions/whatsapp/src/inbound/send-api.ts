// Whatsapp API module exposes the plugin public contract.
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
  WAPresence,
} from "baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { resolveWhatsAppDocumentFileName } from "../document-filename.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { isWhatsAppNewsletterJid } from "../normalize.js";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import { toWhatsappJid, toWhatsappJidWithLid } from "../text-runtime.js";
import {
  addWhatsAppOutboundMentionsToContent,
  type WhatsAppOutboundMentionResolution,
} from "./outbound-mentions.js";
import {
  combineWhatsAppSendResults,
  normalizeWhatsAppSendResult,
  type WhatsAppSendKind,
  type WhatsAppSendResult,
} from "./send-result.js";
import type { ActiveWebSendOptions } from "./types.js";

export type LabelActionBody =
  | { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number }
  | { id: string }[];

type StructuredContactSend = {
  displayName: string;
  vcard: string;
};

type StructuredLocationSend = {
  address?: string;
  degreesLatitude: number;
  degreesLongitude: number;
  name?: string;
};

type StructuredStickerSendOptions = {
  mimetype?: string;
};

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function supportsForcedDocumentMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (
      jid: string,
      content: AnyMessageContent,
      options?: MiscMessageGenerationOptions,
    ) => Promise<WAMessage | undefined>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    addChatLabel: (jid: string, labelId: string) => Promise<void>;
    removeChatLabel: (jid: string, labelId: string) => Promise<void>;
    getLabels?: () => Promise<
      { id: string; name: string; color: number; deleted: boolean; predefinedId?: string }[]
    >;
    createLabel?: (
      name: string,
      color: number,
    ) => Promise<{ id: string; name: string; color: number }>;
    addLabel?: (jid: string, labels: LabelActionBody) => Promise<void>;
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
  };
  defaultAccountId: string;
  resolveOutboundMentions?: (params: {
    jid: string;
    text: string;
  }) => Promise<WhatsAppOutboundMentionResolution> | WhatsAppOutboundMentionResolution;
  // When provided, lets outbound resolve `{phone}@s.whatsapp.net` to `{lid}@lid`
  // via Baileys' lid-mapping-{phone-digits}.json files in the auth dir, so
  // proactive sends to LID-addressed contacts reach the recipient instead of
  // ending up in a sender-only ghost chat (#67378). Defaults to PN-only.
  authDir?: string;
}) {
  const resolveOutboundJid = (recipient: string): string =>
    params.authDir
      ? toWhatsappJidWithLid(recipient, { authDir: params.authDir })
      : toWhatsappJid(recipient);
  const resolveMentions = async (
    jid: string,
    text: string,
  ): Promise<WhatsAppOutboundMentionResolution> =>
    params.resolveOutboundMentions
      ? await params.resolveOutboundMentions({ jid, text })
      : { text, mentionedJids: [] };
  const sendStructuredMessage = async (
    to: string,
    content: AnyMessageContent,
    kind: WhatsAppSendKind,
  ): Promise<WhatsAppSendResult> => {
    const jid = resolveOutboundJid(to);
    const result = await params.sock.sendMessage(jid, content);
    recordWhatsAppOutbound(params.defaultAccountId);
    return normalizeWhatsAppSendResult(result, kind);
  };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaTypeInput?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<WhatsAppSendResult> => {
      let mediaType = mediaTypeInput;
      const jid = resolveOutboundJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      const shouldSendAudioText = Boolean(
        mediaBuffer && mediaType?.startsWith("audio/") && text.trim(),
      );
      const resolvedPayloadText = shouldSendAudioText
        ? { text, mentionedJids: [] }
        : await resolveMentions(jid, text);
      if (mediaBuffer && mediaType) {
        if (sendOptions?.asDocument === true && supportsForcedDocumentMediaType(mediaType)) {
          const fileName = resolveWhatsAppDocumentFileName({
            fileName: sendOptions?.fileName,
            mimetype: mediaType,
          });
          payload = {
            document: mediaBuffer,
            fileName,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("image/")) {
          payload = await addWhatsAppImagePreviewFields({
            image: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          });
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = resolveWhatsAppDocumentFileName({
            fileName: sendOptions?.fileName,
            mimetype: mediaType,
          });
          payload = {
            document: mediaBuffer,
            fileName,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text: resolvedPayloadText.text };
      }
      payload = addWhatsAppOutboundMentionsToContent(payload, resolvedPayloadText.mentionedJids);
      const quotedOpts = buildQuotedMessageOptions({
        messageId: sendOptions?.quotedMessageKey?.id,
        remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
        fromMe: sendOptions?.quotedMessageKey?.fromMe,
        participant: sendOptions?.quotedMessageKey?.participant,
        messageText: sendOptions?.quotedMessageKey?.messageText,
      });
      const result = quotedOpts
        ? await params.sock.sendMessage(jid, payload, quotedOpts)
        : await params.sock.sendMessage(jid, payload);
      const results = [normalizeWhatsAppSendResult(result, mediaBuffer ? "media" : "text")];
      if (shouldSendAudioText) {
        const resolvedAudioText = await resolveMentions(jid, text);
        const textPayload = addWhatsAppOutboundMentionsToContent(
          { text: resolvedAudioText.text },
          resolvedAudioText.mentionedJids,
        );
        const textResult = quotedOpts
          ? await params.sock.sendMessage(jid, textPayload, quotedOpts)
          : await params.sock.sendMessage(jid, textPayload);
        results.push(normalizeWhatsAppSendResult(textResult, "text"));
      }
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      return combineWhatsAppSendResults(mediaBuffer ? "media" : "text", results);
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          poll: {
            name: poll.question,
            values: poll.options,
            selectableCount: poll.maxSelections ?? 1,
          },
        } as AnyMessageContent,
        "poll",
      );
    },
    sendContact: async (
      to: string,
      contact: StructuredContactSend,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          contacts: {
            displayName: contact.displayName,
            contacts: [
              {
                displayName: contact.displayName,
                vcard: contact.vcard,
              },
            ],
          },
        } as AnyMessageContent,
        "contact",
      );
    },
    sendLocation: async (
      to: string,
      location: StructuredLocationSend,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          location: {
            degreesLatitude: location.degreesLatitude,
            degreesLongitude: location.degreesLongitude,
            name: location.name,
            address: location.address,
          },
        } as AnyMessageContent,
        "location",
      );
    },
    sendSticker: async (
      to: string,
      stickerBuffer: Buffer,
      options?: StructuredStickerSendOptions,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          sticker: stickerBuffer,
          mimetype: options?.mimetype ?? "image/webp",
        } as AnyMessageContent,
        "sticker",
      );
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<WhatsAppSendResult> => {
      // Resolve DM targets through the same LID-aware path as normal sends so
      // reactions land on the delivered WhatsApp message key.
      const jid = resolveOutboundJid(chatJid);
      const result = await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
      return normalizeWhatsAppSendResult(result, "reaction");
    },
    addChatLabel: async (chatJid: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addChatLabel(jid, labelId);
    },
    removeChatLabel: async (chatJid: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.removeChatLabel(jid, labelId);
    },
    getLabels: async () => {
      return (await params.sock.getLabels?.()) ?? [];
    },
    createLabel: async (name: string, color: number) => {
      return await params.sock.createLabel?.(name, color);
    },
    addLabel: async (chatJid: string, labels: LabelActionBody): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addLabel?.(jid, labels);
    },
    addMessageLabel: async (chatJid: string, messageId: string, labelId: string): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.addMessageLabel?.(jid, messageId, labelId);
    },
    removeMessageLabel: async (
      chatJid: string,
      messageId: string,
      labelId: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.removeMessageLabel?.(jid, messageId, labelId);
    },
    onWhatsApp: async (...phoneNumbers: string[]) => {
      return await params.sock.onWhatsApp?.(...phoneNumbers);
    },
    getBusinessProfile: async (jid: string) => {
      return await params.sock.getBusinessProfile?.(toWhatsappJid(jid));
    },
    fetchStatus: async (...jids: string[]) => {
      return await params.sock.fetchStatus?.(...jids);
    },
    chatModify: async (mod: unknown, jid: string): Promise<void> => {
      await params.sock.chatModify?.(mod, toWhatsappJid(jid));
    },
    fetchBlocklist: async () => {
      return await params.sock.fetchBlocklist?.();
    },
    profilePictureUrl: async (jid: string, type?: "preview" | "image", timeoutMs?: number) => {
      return await params.sock.profilePictureUrl?.(toWhatsappJid(jid), type, timeoutMs);
    },
    groupMetadata: async (jid: string) => {
      return await params.sock.groupMetadata?.(toWhatsappJid(jid));
    },
    readMessages: async (keys: unknown[]): Promise<void> => {
      await params.sock.readMessages?.(keys);
    },
    star: async (
      jid: string,
      messages: { id: string; fromMe?: boolean }[],
      star: boolean,
    ): Promise<void> => {
      await params.sock.star?.(toWhatsappJid(jid), messages, star);
    },
    fetchMessageHistory: async (
      count: number,
      oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string },
      oldestMsgTimestamp: number,
    ): Promise<string> => {
      if (!params.sock.fetchMessageHistory) {
        throw new Error("fetchMessageHistory not available on this socket");
      }
      return await params.sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = resolveOutboundJid(to);
      if (isWhatsAppNewsletterJid(jid)) {
        return;
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
