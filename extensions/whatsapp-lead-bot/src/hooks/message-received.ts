/**
 * message_received hook - intercepts incoming WhatsApp messages.
 * Processing is split into a pipeline of named filter steps.
 */

import type { AdminCommandHandler } from "../admin/commands.js";
import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import { getContext } from "../context.js";
import { appendLeadEvent } from "../crm-memory/lead-events.js";
import { resolveTrustedWhatsAppLeadScope } from "../crm-memory/lead-scope.js";
import { resolveCrmMemoryRolloutFlags } from "../crm-memory/rollout.js";
import type { Database } from "../database.js";
import type { Lead } from "../database/schema.js";
import type { HandoffManager } from "../handoff/manager.js";
import type { MediaHandler } from "../media/handler.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { RateLimitCoordinator } from "../rate-limit/coordinator.js";
import type { RateLimiter } from "../rate-limit/limiter.js";
import type { Runtime } from "../runtime.js";
import type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedResult,
} from "../types.js";
import { normalizePhone } from "../utils/phone.js";
import type { HandoffInterceptor } from "./handoff-interceptor.js";

export interface MessageReceivedHandlerDeps {
  db: Database;
  config: WhatsAppLeadBotConfig;
  adminHandler: AdminCommandHandler;
  rateLimiter: RateLimiter;
  rateLimitCoordinator: RateLimitCoordinator;
  mediaHandler: MediaHandler;
  agentNotifier: AgentNotifier;
  handoffManager: HandoffManager;
  handoffInterceptor: HandoffInterceptor;
  crmSyncWake?: () => void;
}

/** Result from a filter step: return a value to short-circuit, or null to continue. */
type FilterResult = PluginHookMessageReceivedResult | null;

interface MessageInput {
  event: PluginHookMessageReceivedEvent;
  ctx: PluginHookMessageContext;
  runtime: Runtime;
}

interface LeadMessageInput extends MessageInput {
  lead: Lead;
}

function isPrimaryAgentRoute(
  config: WhatsAppLeadBotConfig,
  ctx: PluginHookMessageContext,
): boolean {
  return !config.agentId || !ctx.agentId || ctx.agentId === config.agentId;
}

function isConfiguredAgentNumber(config: WhatsAppLeadBotConfig, phone: string): boolean {
  const normalizedPhone = normalizePhone(phone);
  return config.agentNumbers.some((agentNumber) => normalizePhone(agentNumber) === normalizedPhone);
}

export function createMessageReceivedHandler(deps: MessageReceivedHandlerDeps) {
  // --- Pre-lead filters (before lead lookup) ---

  function filterChannel({ ctx }: MessageInput): FilterResult {
    if (ctx.channelId !== "whatsapp") {
      return {};
    }
    return null;
  }

  function filterAccount({ ctx }: MessageInput): FilterResult {
    const { accountId } = ctx;
    if (deps.config.whatsappAccounts.length > 0 && accountId) {
      if (!deps.config.whatsappAccounts.includes(accountId)) {
        console.log(
          `[lead-bot] Skipping message - accountId "${accountId}" not in configured list [${deps.config.whatsappAccounts.join(", ")}]`,
        );
        return {};
      }
    }
    return null;
  }

  function filterOpenClawLoop({ event }: MessageInput): FilterResult {
    if (event.metadata?.openclawInitiated === true) {
      return { suppress: true };
    }
    return null;
  }

  async function filterAdminCommand({ event, runtime }: MessageInput): Promise<FilterResult> {
    const { from, content, metadata } = event;
    const to = metadata?.to as string | undefined;
    const sentByAccountOwner = metadata?.sentByAccountOwner === true;
    const sameNumber = Boolean(to) && normalizePhone(from) === normalizePhone(to);
    const configuredAgentNumber = isConfiguredAgentNumber(deps.config, from);
    const adminSource =
      sentByAccountOwner || sameNumber || configuredAgentNumber || deps.adminHandler.isAdmin(from);

    console.log(
      `[message-received] Admin check: from=${from}, to=${to}, sameNumber=${sameNumber}, sentByAccountOwner=${sentByAccountOwner}, configuredAgentNumber=${configuredAgentNumber}`,
    );

    if (!adminSource) {
      return null;
    }

    console.log(`[message-received] Detected admin message, parsing command: "${content}"`);
    const command = deps.adminHandler.parseCommand(content);
    console.log(`[message-received] Parsed command:`, command);

    if (command) {
      try {
        const response = await deps.adminHandler.execute(command, runtime);
        await runtime.sendMessage(from, {
          text: response,
          metadata: { openclawInitiated: true },
        });
      } catch (err) {
        console.error(`[lead-bot] Admin command error (still suppressing):`, err);
      }
      return { suppress: true };
    }
    return null;
  }

  async function filterWhatsAppWebHandoff({ event }: MessageInput): Promise<FilterResult> {
    const { from, metadata } = event;
    if (metadata?.sentByAccountOwner !== true) {
      return null;
    }

    const lead = await deps.db.getLeadByPhone(from);
    if (lead) {
      await deps.handoffManager.triggerWhatsAppWebHandoff(lead.id, from);
    }
    return { suppress: true };
  }

  // --- Post-lead filters (after lead lookup) ---

  function filterLeadStatus({ lead }: LeadMessageInput): FilterResult {
    if (lead.status === "blocked" || lead.status === "ignored" || lead.status === "handed_off") {
      return { suppress: true };
    }
    return null;
  }

  async function filterRateLimitExpiry({ lead }: LeadMessageInput): Promise<FilterResult> {
    if (lead.status !== "rate_limited") {
      return null;
    }

    const limitExpired = await deps.rateLimiter.isLimitExpired(lead.id);
    if (!limitExpired) {
      return { suppress: true };
    }

    await deps.rateLimiter.clearLimit(lead.id);
    await deps.db.updateLeadStatus(lead.id, "qualifying");
    return null;
  }

  async function filterRateLimit({ lead }: LeadMessageInput): Promise<FilterResult> {
    const coordResult = await deps.rateLimitCoordinator.checkAndRecord(lead.id);
    if (coordResult.allowed) {
      return null;
    }

    await deps.db.updateLeadStatus(lead.id, "rate_limited");
    await deps.db.logHandoffEvent(lead.id, "rate_limited", "system", {
      layer: coordResult.layer,
      reason: coordResult.reason,
    });
    await deps.agentNotifier.notifyRateLimit(lead, coordResult.reason || "Unknown");
    return { suppress: true };
  }

  async function filterOptOut({ event, runtime, lead }: LeadMessageInput): Promise<FilterResult> {
    const optOutKeywords = ["stop", "unsubscribe", "quit", "cancel"];
    if (!optOutKeywords.some((kw) => event.content.toLowerCase().includes(kw))) {
      return null;
    }

    await deps.db.updateLeadStatus(lead.id, "ignored");
    await runtime.sendMessage(event.from, {
      text: "Understood. You won't receive any more messages from us. Thanks for your time!",
      metadata: { openclawInitiated: true },
    });
    return { suppress: true };
  }

  async function filterMedia({ event, runtime, lead }: LeadMessageInput): Promise<FilterResult> {
    const { from, content, metadata } = event;
    let mediaType = (metadata?.MediaType || metadata?.mediaType) as string | undefined;
    let mediaPath = metadata?.mediaPath as string | undefined;

    // Fallback: Extract media info from content
    if (!mediaType && content.includes("[media attached:")) {
      const mediaMatch = content.match(/\[media attached: (.+?) \((.+?)\)\]/);
      if (mediaMatch) {
        mediaPath = mediaMatch[1];
        mediaType = mediaMatch[2];
        console.log(
          `[message-received] Extracted media from content: type=${mediaType}, path=${mediaPath}`,
        );
      }
    }

    console.log(
      `[message-received] Checking media: mediaType=${mediaType}, hasMediaHandler=${Boolean(deps.mediaHandler)}, metadata keys=${Object.keys(metadata || {}).join(",")}`,
    );

    if (!mediaType || mediaType === "text/plain") {
      return null;
    }

    if (!deps.mediaHandler) {
      console.warn(
        `[message-received] mediaHandler not initialized yet, skipping media processing`,
      );
      return {};
    }

    const fileSize = metadata?.fileSize as number | undefined;
    console.log(
      `[message-received] Calling mediaHandler.handleMedia: type=${mediaType}, path=${mediaPath}`,
    );

    const ack = deps.mediaHandler.getAckText(lead, mediaType);
    await runtime.sendMessage(from, {
      text: ack.text,
      metadata: { openclawInitiated: true },
    });

    const result = await deps.mediaHandler.handleMedia(lead, mediaType, mediaPath, fileSize);
    return { suppress: result.suppress, content: result.content };
  }

  function filterSlashCommand({ event }: MessageInput): FilterResult {
    if (event.content.trimStart().startsWith("/")) {
      return { suppress: true };
    }
    return null;
  }

  // --- Pipeline runner ---

  async function handleMessage(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageReceivedResult> {
    const input: MessageInput = { event, ctx, runtime: getContext().runtime };

    // Pre-lead filters
    const preLeadFilters = [filterChannel, filterAccount, filterOpenClawLoop];
    for (const filter of preLeadFilters) {
      const result = filter(input);
      if (result !== null) {
        return result;
      }
    }

    console.log(
      `[lead-bot] Processing message on accountId="${ctx.accountId}" from="${event.from}"`,
    );

    // Async pre-lead filters
    for (const filter of [filterAdminCommand, filterWhatsAppWebHandoff] as const) {
      const result = await filter(input);
      if (result !== null) {
        return result;
      }
    }

    const preRouteSlashResult = filterSlashCommand(input);
    if (preRouteSlashResult !== null) {
      return preRouteSlashResult;
    }

    if (!isPrimaryAgentRoute(deps.config, ctx)) {
      return {};
    }

    // --- Lead lookup ---
    const leadScope = resolveTrustedWhatsAppLeadScope({ event, ctx });
    if (!leadScope.ok) {
      console.log(`[lead-bot] Skipping lead lookup: ${leadScope.reason}`);
      return leadScope.reason === "not_whatsapp" ? {} : { suppress: true };
    }

    let lead = await deps.db.getOrCreateLead(leadScope.scope.leadPhone);
    await deps.db.updateLeadTimestamp(lead.id, event.timestamp || Date.now());
    appendInboundCrmMessageEvent({ event, lead, leadScope });
    deps.crmSyncWake?.();

    // Re-fetch lead to ensure we have the latest status (race condition fix)
    // In case handoff was triggered between getOrCreateLead and now
    lead = (await deps.db.getLeadById(lead.id)) || lead;

    // Capture ctwa_clid from Click-to-WhatsApp ads
    const ctwaClid = event.metadata?.ctwaClid as string | undefined;
    if (ctwaClid) {
      try {
        const existing = lead.custom_fields ? JSON.parse(lead.custom_fields) : {};
        if (!existing.ctwa_clid) {
          await deps.db.updateCustomFields(lead.id, {
            ctwa_clid: ctwaClid,
            ctwa_clid_captured_at: Date.now(),
          });
          console.log(`[lead-bot] Captured ctwa_clid for ${leadScope.scope.leadPhone}`);
        }
      } catch (err) {
        console.error(`[lead-bot] Failed to save ctwa_clid:`, err);
      }
    }

    // Post-lead filters
    const leadInput: LeadMessageInput = { ...input, lead };

    // Silent capture: process media/text during handoff before suppressing
    const handoffResult = await deps.handoffInterceptor.handle(leadInput);
    if (handoffResult !== null) {
      return handoffResult;
    }

    const postLeadFilters = [
      filterLeadStatus,
      filterRateLimitExpiry,
      filterRateLimit,
      filterOptOut,
      filterMedia,
    ] as const;

    for (const filter of postLeadFilters) {
      const result = await filter(leadInput);
      if (result !== null) {
        return result;
      }
    }

    // Update timestamp for follow-up tracking
    await deps.db.updateLastBotReply(lead.id, Date.now());

    // Slash command filter (after bot reply timestamp update)
    const slashResult = filterSlashCommand(leadInput);
    if (slashResult !== null) {
      return slashResult;
    }

    // Let the solayre agent handle the actual conversation
    return {};
  }

  function appendInboundCrmMessageEvent(input: {
    event: PluginHookMessageReceivedEvent;
    lead: Lead;
    leadScope: ReturnType<typeof resolveTrustedWhatsAppLeadScope>;
  }): void {
    const flags = resolveCrmMemoryRolloutFlags(deps.config.crmMemory);
    if (!flags.eventWritesEnabled || !input.leadScope.ok) {
      return;
    }

    try {
      appendLeadEvent({
        scope: input.leadScope,
        log: deps.db,
        now: () => input.event.timestamp || Date.now(),
        event: {
          type: "message.received",
          actor: "prospect",
          source: {
            channel: "whatsapp",
            messageId: firstString(input.event.metadata?.messageId),
          },
          summary: "Inbound WhatsApp message received.",
          payload: {
            leadId: input.lead.id,
            content: input.event.content,
            mediaType: firstString(
              input.event.metadata?.mediaType,
              input.event.metadata?.MediaType,
            ),
            hasMedia: Boolean(input.event.metadata?.mediaPath),
          },
        },
      });
    } catch (err) {
      console.error(`[lead-bot] Failed to append CRM memory message event:`, err);
    }
  }

  // --- Hook entry point ---

  return async function onMessageReceived(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageReceivedResult> {
    try {
      return await handleMessage(event, ctx);
    } catch (err) {
      console.error(`[lead-bot] Hook crashed (suppressing to be safe):`, err);
      return { suppress: true };
    }
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
