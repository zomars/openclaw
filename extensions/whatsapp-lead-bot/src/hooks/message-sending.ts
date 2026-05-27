/**
 * message_sending hook - detects human agent takeover + handles multi-message responses
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import type { Database } from "../database.js";
import type { HandoffManager } from "../handoff/manager.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageContext,
  PluginHookMessageSendingResult,
} from "../types.js";
import type { MessageQueue } from "./message-queue.js";
import { splitAgentResponse } from "./multi-message-splitter.js";

export interface MessageSendingHandlerDeps {
  db: Database;
  config: WhatsAppLeadBotConfig;
  handoffManager: HandoffManager;
  messageQueue: MessageQueue;
}

export function createMessageSendingHandler(deps: MessageSendingHandlerDeps) {
  return async function onMessageSending(
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageSendingResult> {
    const { to, content, metadata } = event;
    const { channelId, accountId } = ctx;

    console.log(
      `[message-sending] Event: channelId=${channelId}, to=${to}, contentLen=${content?.length}, isOpenclaw=${String(metadata?.openclawInitiated)}`,
    );

    // Only handle WhatsApp messages
    if (channelId !== "whatsapp") {
      return {};
    }

    // Filter by WhatsApp account if configured
    if (deps.config.whatsappAccounts.length > 0 && accountId) {
      if (!deps.config.whatsappAccounts.includes(accountId)) {
        console.log(`[message-sending] Skipping - accountId ${accountId} not in config`);
        return {};
      }
    }

    // Translate error messages to Spanish for WhatsApp leads.
    // Runs before lead lookup since errors aren't lead-specific.
    if (content) {
      const translated = translateErrorToSpanish(content);
      if (translated !== undefined) {
        return { content: translated };
      }
    }

    const isDryRun =
      deps.config.dryRunPrefixes.length > 0 &&
      to &&
      deps.config.dryRunPrefixes.some((prefix) => to.startsWith(prefix));

    const lead = await deps.db.getLeadByPhone(to);
    if (!lead) {
      console.log(`[message-sending] No lead found for ${to}`);
      return {};
    }

    // Check if message was explicitly marked as initiated by OpenClaw (the bot).
    // Some core auto-reply paths invoke message_sending without metadata, so
    // absence of openclawInitiated is not proof that a human agent took over.
    // Only trigger handoff on an explicit human signal.
    const isOpenClawMessage = metadata?.openclawInitiated === true;
    const isExplicitHumanMessage = metadata?.openclawInitiated === false;

    if (isExplicitHumanMessage && lead.status !== "handed_off") {
      await deps.handoffManager.triggerHumanMessageHandoff(lead.id);
    }

    // Output filter: check for content that should never reach leads
    // LOG-ONLY mode — monitor for false positives before enabling blocking
    if (isOpenClawMessage && content) {
      const matched = checkLeadContentFilter(content);
      if (matched) {
        console.warn(`[message-sending:filter] WOULD BLOCK to ${lead.id}: matched="${matched}"`);
      }
    }

    // Handle multi-message responses from agent
    if (isOpenClawMessage && content) {
      console.log(`[message-sending] Checking for multi-message content (${content.length} chars)`);
      const split = splitAgentResponse(content);
      console.log(
        `[message-sending] Split result: isMulti=${split.isMulti}, strategy=${split.strategy}, count=${split.messages.length}`,
      );

      if (split.isMulti && split.messages.length > 1) {
        console.log(
          `[message-sending] Detected ${split.messages.length} messages in agent response`,
        );

        for (let i = 1; i < split.messages.length; i++) {
          deps.messageQueue.add(to, {
            to,
            content: split.messages[i],
            metadata: { openclawInitiated: true },
            accountId,
            delayMs: i * 1000,
          });
        }

        console.log(`[message-sending] Queued ${split.messages.length - 1} additional messages`);
        if (isDryRun) {
          console.log(`[message-sending] Dry-run hit for ${to} — cancelling delivery (multi-msg)`);
          while (deps.messageQueue.hasQueued(to, accountId)) {
            deps.messageQueue.pop(to, accountId);
          }
          return { cancel: true };
        }
        return { content: split.messages[0] };
      }
    }

    // Dry-run mode: cancel delivery after running full hook logic
    if (isDryRun) {
      console.log(`[message-sending] Dry-run hit for ${to} — cancelling delivery`);
      return { cancel: true };
    }

    return {};
  };
}

/**
 * Patterns that should never appear in messages sent to leads.
 * Returns the matched pattern string if found, null otherwise.
 */
const LEAD_BLOCKED_PATTERNS: RegExp[] = [
  /\bsoy (un |una )?(bot|asistente virtual|ia|inteligencia artificial|agente automatizado|sistema automatizado|programa|software)\b/i,
  /\b(robot|chatbot|machine|máquina)\b/i,
  /\basistente (virtual|automatizado|digital)\b/i,
  /\b(openclaw|whatsapp-lead-bot|supabase|handoff)\b/i,
  /\bcfe_download|parse-cfe-receipt|calculate-quote\b/i,
  /\bopenclaw\.json\b/i,
  /\bplugin\b/i,
  /\bwebhook\b/i,
];

// ---------------------------------------------------------------------------
// Error text translation: intercept upstream English error messages and
// replace with Spanish for WhatsApp leads. This runs inside the
// message_sending hook so core errors.ts stays upstream-clean.
// ---------------------------------------------------------------------------

const SPANISH_GENERIC_ERROR = "Permitenos un momento. Te atenderemos tan pronto nos sea posible.";

const SPANISH_BILLING_ERROR =
  "El servicio no esta disponible temporalmente. Por favor intente mas tarde.";

/** Detect provider-specific rate-limit hints worth preserving in English. */
const RATE_LIMIT_SPECIFIC_HINT_RE =
  /\bmin(?:ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\breset\b|\bplan\b|\bquota\b/i;

/**
 * Match sanitized English error output and return Spanish replacement.
 * Returns `undefined` for non-error content (pass-through).
 */
export function translateErrorToSpanish(content: string): string | undefined {
  // Exact matches against upstream sanitize-user-facing-text.ts defaults
  if (content === "\u26a0\ufe0f API rate limit reached. Please try again later.") {
    return SPANISH_GENERIC_ERROR;
  }
  if (content === "The AI service is temporarily overloaded. Please try again in a moment.") {
    return SPANISH_GENERIC_ERROR;
  }

  // Provider-specific rate-limit message (starts with ⚠️ and contains time/quota hints).
  // These are actionable — preserve the English detail for operators.
  if (content.startsWith("\u26a0\ufe0f") && RATE_LIMIT_SPECIFIC_HINT_RE.test(content)) {
    return undefined;
  }

  // Fuzzy fallback for rate-limit / overloaded errors that don't match exact strings
  if (/rate limit|too many requests/i.test(content) && content.startsWith("\u26a0\ufe0f")) {
    return SPANISH_GENERIC_ERROR;
  }
  if (/overloaded|service unavailable/i.test(content)) {
    return SPANISH_GENERIC_ERROR;
  }

  // Billing errors
  if (/billing error|run out of credits|insufficient balance/i.test(content)) {
    return SPANISH_BILLING_ERROR;
  }

  return undefined;
}

export function checkLeadContentFilter(content: string): string | null {
  for (const pattern of LEAD_BLOCKED_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}
