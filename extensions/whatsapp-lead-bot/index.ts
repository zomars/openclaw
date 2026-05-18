/**
 * WhatsApp Lead Bot Plugin
 *
 * AI-powered lead qualification bot for WhatsApp with admin commands,
 * rate limiting, and follow-ups.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sendWebChannelMessage } from "../../src/plugins/runtime/runtime-web-channel-plugin.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { AdminCommandHandler } from "./src/admin/commands.js";
import { createParseAndQuoteClient } from "./src/cfe/parse-and-quote-client.js";
import { CompositeCoworkerDirectory } from "./src/config/coworker-directory.js";
import { MacOSContactsResolver } from "./src/config/coworker-directory/macos-contacts-resolver.js";
import { OpenclawJsonWhitelistSource } from "./src/config/coworker-whitelist/openclaw-json-whitelist.js";
import { WhatsAppLeadBotConfigSchema } from "./src/config/schema.js";
import { withContext } from "./src/context.js";
import { SqliteDatabase } from "./src/database/connection.js";
import { HandoffManager } from "./src/handoff/manager.js";
import { createAttributionOverrideHandler } from "./src/hooks/attribution-override.js";
import { createBeforePromptBuildHandler } from "./src/hooks/before-prompt-build.js";
import { createBeforeToolCallHandler } from "./src/hooks/before-tool-call.js";
import { HandoffInterceptor } from "./src/hooks/handoff-interceptor.js";
import { MessageQueue } from "./src/hooks/message-queue.js";
import { createMessageReceivedHandler } from "./src/hooks/message-received.js";
import { createMessageSendingHandler } from "./src/hooks/message-sending.js";
import { createMessageSentHandler } from "./src/hooks/message-sent.js";
import { ViolationTracker } from "./src/hooks/violation-tracker.js";
import { WhatsAppLabelService } from "./src/labels.js";
import { MediaHandler } from "./src/media/handler.js";
import { parseRawMessage } from "./src/messages/parse-raw.js";
import { AgentNotifier } from "./src/notifications/agent-notify.js";
import { CircuitBreaker } from "./src/rate-limit/circuit-breaker.js";
import { RateLimitCoordinator } from "./src/rate-limit/coordinator.js";
import { GlobalRateLimiter } from "./src/rate-limit/global-limiter.js";
import { RateLimiter } from "./src/rate-limit/limiter.js";
import type { Runtime } from "./src/runtime.js";
import { FileSessionResetter } from "./src/session-resetter/file-resetter.js";
import { blockLeadTool } from "./src/tools/block-lead.js";
import { editQuoteTool } from "./src/tools/edit-quote.js";
import { getFollowupCandidatesTool } from "./src/tools/get-followup-candidates.js";
import { getLeadTool } from "./src/tools/get-lead.js";
import { handoffLeadTool } from "./src/tools/handoff-lead.js";
import { addChatLabelTool, createLabelTool, getLabelsTool } from "./src/tools/label-ops.js";
import { listCoworkersTool } from "./src/tools/list-coworkers.js";
import { listLeadsTool } from "./src/tools/list-leads.js";
import { processCFEReceiptCustomerTool } from "./src/tools/process-cfe-receipt-customer.js";
import { processCFEReceiptTool } from "./src/tools/process-cfe-receipt.js";
import { saveLeadTool } from "./src/tools/save-lead.js";
import { saveReceiptDataTool } from "./src/tools/save-receipt-data.js";
import { sendDisqualificationTool } from "./src/tools/send-disqualification.js";
import { sendHandoffToAleTool } from "./src/tools/send-handoff-to-ale.js";
import { sendReceiptRequestTool } from "./src/tools/send-receipt-request.js";
import { syncLabelsTool } from "./src/tools/sync-labels.js";
import { whatsappHistoryFetchTool } from "./src/tools/whatsapp-history-fetch.js";
import { normalizePhone } from "./src/utils/phone.js";
const plugin = {
  id: "whatsapp-lead-bot",
  name: "WhatsApp Lead Bot",
  description:
    "AI-powered lead qualification bot for WhatsApp with admin commands, rate limiting, and follow-ups",
  configSchema: WhatsAppLeadBotConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = WhatsAppLeadBotConfigSchema.parse(api.pluginConfig);

    if (!config.enabled) {
      console.log("[whatsapp-lead-bot] Plugin disabled in config");
      return;
    }

    // Resolve database path
    const stateDir = api.runtime?.stateDir;
    if (!config.dbPath && !stateDir) {
      console.error(
        "[whatsapp-lead-bot] Neither config.dbPath nor api.runtime.stateDir is available",
      );
      return;
    }
    const dbPath = config.dbPath || path.join(stateDir, "whatsapp-lead-bot", "leads.db");

    // Initialize database (better-sqlite3 is synchronous)
    const db = new SqliteDatabase({ dbPath });
    db.migrate();
    console.log(`[whatsapp-lead-bot] Database initialized at ${dbPath}`);

    // Wire dependencies (DI composition root)
    const rateLimiter = new RateLimiter(db, config.rateLimit);

    // WhatsApp-specific runtime extensions (not in public plugin API type)
    const waRuntime = (api.runtime as Record<string, unknown>)?.channel as
      | { whatsapp?: Record<string, (...args: unknown[]) => unknown> }
      | undefined;
    const waFns = waRuntime?.whatsapp;

    // Create runtime adapter factory for sending messages from specific accounts
    const getRuntime = (accountId?: string): Runtime => {
      return {
        async sendMessage(
          to: string,
          content: { text: string; metadata?: Record<string, unknown> },
        ) {
          console.log(`[lead-bot] Sending message TO ${to} FROM accountId="${accountId}"`);
          try {
            await sendWebChannelMessage(to, content.text, {
              verbose: false,
              accountId: accountId,
            });
          } catch (err) {
            console.error("[lead-bot] sendWebChannelMessage failed:", err);
          }
        },
        async addChatLabel(chatJid: string, labelId: string) {
          try {
            if (typeof waFns?.addChatLabelWhatsApp === "function") {
              await waFns?.addChatLabelWhatsApp(chatJid, labelId, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] addChatLabel failed:", err);
          }
        },
        async removeChatLabel(chatJid: string, labelId: string) {
          try {
            if (typeof waFns?.removeChatLabelWhatsApp === "function") {
              await waFns?.removeChatLabelWhatsApp(chatJid, labelId, { accountId });
            }
          } catch (err) {
            console.error("[lead-bot] removeChatLabel failed:", err);
          }
        },
        async getLabels() {
          try {
            if (typeof waFns?.getLabelsWhatsApp === "function") {
              return await waFns?.getLabelsWhatsApp({ accountId });
            }
          } catch (err) {
            console.error("[lead-bot] getLabels failed:", err);
          }
          return [];
        },
        async createLabel(name: string, color: number) {
          try {
            if (typeof waFns?.createLabelWhatsApp === "function") {
              return await waFns?.createLabelWhatsApp(name, color, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] createLabel failed:", err);
          }
          return undefined;
        },
        async addLabel(
          chatJid: string,
          labels: { id: string; name?: string; color?: number; deleted?: boolean },
        ) {
          try {
            if (typeof waFns?.addLabelWhatsApp === "function") {
              await waFns?.addLabelWhatsApp(chatJid, labels, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] addLabel failed:", err);
          }
        },
        async addMessageLabel(chatJid: string, messageId: string, labelId: string) {
          try {
            if (typeof waFns?.addMessageLabelWhatsApp === "function") {
              await waFns?.addMessageLabelWhatsApp(chatJid, messageId, labelId, { accountId });
            }
          } catch (err) {
            console.error("[lead-bot] addMessageLabel failed:", err);
          }
        },
        async removeMessageLabel(chatJid: string, messageId: string, labelId: string) {
          try {
            if (typeof waFns?.removeMessageLabelWhatsApp === "function") {
              await waFns?.removeMessageLabelWhatsApp(chatJid, messageId, labelId, { accountId });
            }
          } catch (err) {
            console.error("[lead-bot] removeMessageLabel failed:", err);
          }
        },
        async onWhatsApp(...phoneNumbers: string[]) {
          try {
            if (typeof waFns?.onWhatsApp === "function") {
              return await waFns?.onWhatsApp(...phoneNumbers, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] onWhatsApp failed:", err);
          }
          return undefined;
        },
        async getBusinessProfile(jid: string) {
          try {
            if (typeof waFns?.getBusinessProfileWhatsApp === "function") {
              return await waFns?.getBusinessProfileWhatsApp(jid, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] getBusinessProfile failed:", err);
          }
          return undefined;
        },
        async chatModify(mod: unknown, jid: string) {
          try {
            if (typeof waFns?.chatModifyWhatsApp === "function") {
              await waFns?.chatModifyWhatsApp(mod, jid, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] chatModify failed:", err);
          }
        },
      };
    };

    // Default runtime for AgentNotifier (hook handlers get runtime via request context)
    const runtime = getRuntime(config.whatsappAccounts[0]);

    const agentNotifier = new AgentNotifier(runtime, config);
    const handoffManager = new HandoffManager(db, agentNotifier);

    // CFE receipt parsing & quoting — single consolidated endpoint.
    const cfeApiKey = process.env.SUPABASE_API_KEY;
    if (!cfeApiKey) {
      console.warn(
        "[whatsapp-lead-bot] No SUPABASE_API_KEY — process_cfe_receipt(_customer) and edit_quote disabled",
      );
    }
    const mediaHandler = new MediaHandler();
    const handoffInterceptor = new HandoffInterceptor({ agentNotifier });

    // Wire 3-layer rate limiting
    const globalLimiter = new GlobalRateLimiter(db, config.rateLimit.global);
    const circuitBreaker = new CircuitBreaker(db, config.rateLimit.circuitBreaker, agentNotifier);
    const rateLimitCoordinator = new RateLimitCoordinator(
      circuitBreaker,
      globalLimiter,
      rateLimiter,
    );

    // Get self E.164 number for admin detection
    // This will need to be retrieved from OpenClaw's WhatsApp channel
    // For now, we'll pass null and admin detection will be disabled
    const selfE164: string | null = null; // TODO: Get from api.runtime or config

    // Wire session resetter for /reset-lead command
    const openclawStateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const agentId = config.agentId || config.whatsappAccounts[0] || "main";

    // Coworker whitelist — single source of truth is openclaw.json bindings.
    // When `coworkerAgentId` is configured, load direct peers bound to that
    // agent so the plugin can treat them as coworkers (bypass lead pipeline,
    // skip lead persistence) instead of duplicating the list in plugin config.
    const openclawConfigPath =
      config.openclawConfigPath ||
      process.env.OPENCLAW_CONFIG_PATH ||
      path.join(openclawStateDir, "openclaw.json");
    const coworkerWhitelist = config.coworkerAgentId
      ? new OpenclawJsonWhitelistSource({
          configPath: openclawConfigPath,
          agentId: config.coworkerAgentId,
          channel: "whatsapp",
        })
      : undefined;
    if (coworkerWhitelist) {
      console.log(
        `[whatsapp-lead-bot] Coworker whitelist source: ${openclawConfigPath} (agentId=${config.coworkerAgentId})`,
      );
    }

    // Coworker directory — pairs the whitelist with display names from macOS
    // Contacts. Falls back gracefully (phones only) if Contacts isn't reachable.
    const coworkerDirectory = coworkerWhitelist
      ? new CompositeCoworkerDirectory({
          whitelist: coworkerWhitelist,
          resolver: new MacOSContactsResolver(),
        })
      : undefined;
    const sessionResetter = new FileSessionResetter(
      openclawStateDir,
      agentId,
      "whatsapp",
      config.whatsappAccounts[0] || "default",
    );

    const messageQueue = new MessageQueue();
    const labelService = new WhatsAppLabelService(config.labels, db);

    const adminHandler = new AdminCommandHandler(
      db,
      handoffManager,
      rateLimiter,
      selfE164,
      sessionResetter,
      circuitBreaker,
      globalLimiter,
      labelService,
    );

    // Register hooks wrapped with request context (accountId → runtime)
    api.on(
      "message_received",
      withContext(
        getRuntime,
        createMessageReceivedHandler,
      )({
        db,
        config,
        adminHandler,
        rateLimiter,
        rateLimitCoordinator,
        mediaHandler,
        agentNotifier,
        handoffManager,
        handoffInterceptor,
        coworkerWhitelist,
      }),
    );

    api.on(
      "message_sending",
      withContext(
        getRuntime,
        createMessageSendingHandler,
      )({
        db,
        config,
        handoffManager,
        messageQueue,
      }),
    );

    api.on("message_sent", withContext(getRuntime, createMessageSentHandler)({ messageQueue }));

    // Attribution override runs first so the LLM-supplied phone is replaced
    // with the runtime sender before any downstream hook or tool sees it.
    // Registered with no expectedAgentId filter — applies to every agent that
    // uses this plugin's tools (solayre-coworker, solayre-leads, etc).
    api.on("before_tool_call", createAttributionOverrideHandler());

    const violationTracker = new ViolationTracker();
    api.on(
      "before_tool_call",
      createBeforeToolCallHandler({
        dryRun: false,
        db,
        violations: violationTracker,
        pricingStrikeThreshold: 2,
        expectedAgentId: config.agentId,
        onPricingEscalation: async ({ phone, hit, blockedText }) => {
          const lead = await db.getLeadByPhone(phone);
          if (!lead) {
            return;
          }
          // Customer ack — same canonical text used by send_handoff_to_ale.
          await runtime.sendMessage(phone, {
            text: "Permítame un momento, le confirmo con un asesor.",
            metadata: { openclawInitiated: true, source: "guardrail-escalation" },
          });
          await handoffManager.triggerHandoff(lead.id, "guardrail_pricing_repeat", "tool");
          try {
            await labelService.applyStatus(phone, "handed_off", runtime);
          } catch (err) {
            console.error(`[guardrail-escalation] Failed to apply HUMANO label: ${String(err)}`);
          }
          // Notify Ale with the blocked text for review.
          const summary =
            `🚨 Guardrail: ${lead.name || phone} (${phone}) tuvo 2+ intentos de mensaje con precios. ` +
            `Patrón: ${hit.pattern}. Texto bloqueado: "${blockedText}". ` +
            "El bot quedó pausado. Continúa la conversación.";
          for (const agentPhone of config.agentNumbers) {
            try {
              await runtime.sendMessage(agentPhone, {
                text: summary,
                metadata: { openclawInitiated: true, source: "guardrail-escalation" },
              });
            } catch (err) {
              console.error(`[guardrail-escalation] Notify ${agentPhone} failed: ${String(err)}`);
            }
          }
        },
      }),
    );
    api.on(
      "before_prompt_build",
      createBeforePromptBuildHandler({ db, expectedAgentId: config.agentId }),
    );

    console.log("[whatsapp-lead-bot] Hooks registered");

    // Clean up DB on plugin unload
    if (typeof api.onUnload === "function") {
      api.onUnload(() => {
        db.close();
      });
    }

    // Helper: register a tool with standard JSON wrapping
    function registerPluginTool<TParams, TCtx>(
      label: string,
      tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        execute: (params: TParams, ctx: TCtx) => Promise<unknown>;
      },
      ctx: TCtx,
    ) {
      api.registerTool({
        name: tool.name,
        label,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId: string, params: TParams) => {
          const result = await tool.execute(params, ctx);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
      console.log(`[whatsapp-lead-bot] Registered tool: ${tool.name}`);
    }

    // Register process_cfe_receipt(_customer) — single consolidated parse-and-quote endpoint.
    if (cfeApiKey) {
      const cfeOutputDir = path.join(stateDir ?? os.homedir(), "whatsapp-lead-bot", "cfe-output");
      try {
        fs.mkdirSync(cfeOutputDir, { recursive: true });
      } catch (err) {
        console.error(`[whatsapp-lead-bot] Failed to create cfeOutputDir: ${String(err)}`);
      }
      const parseAndQuoteClient = createParseAndQuoteClient({
        apiKey: cfeApiKey,
        apiUrl: config.parseAndQuoteUrl,
        editQuoteUrl: config.editQuoteUrl,
      });
      const saveLeadDep = async (input: { phone: string; name: string; notes?: string }) => {
        const result = (await saveLeadTool.execute(
          { phone: input.phone, name: input.name, notes: input.notes },
          { db, labelService, runtime },
        )) as { success: boolean; lead?: { id: number } };
        if (!result.success || !result.lead) {
          throw new Error("save_lead returned no lead");
        }
        return { leadId: result.lead.id };
      };
      const saveQuoteIdDep = async (input: {
        leadId: number;
        quoteId: string;
        quoteNumber: string;
      }) => {
        await db.updateQuoteData(input.leadId, {
          notes: JSON.stringify({ quoteId: input.quoteId, quoteNumber: input.quoteNumber }),
          quoted_at: Date.now(),
        });
      };
      const downloadFileDep = async (url: string, destPath: string) => {
        // Include API key for Supabase URLs — cached responses may return expired signed tokens
        const fetchHeaders: Record<string, string> = {};
        if (cfeApiKey && url.includes("supabase.co")) {
          fetchHeaders["X-API-Key"] = cfeApiKey;
        }
        const response = await fetch(url, { headers: fetchHeaders });
        if (!response.ok || !response.body) {
          throw new Error(`downloadFile ${url} → HTTP ${response.status}`);
        }
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          fs.createWriteStream(destPath),
        );
        return destPath;
      };

      const isCoworker = coworkerWhitelist
        ? async (phone: string) => (await coworkerWhitelist.load()).has(normalizePhone(phone))
        : undefined;

      registerPluginTool("Process CFE Receipt", processCFEReceiptTool, {
        parseAndQuote: (input) => parseAndQuoteClient.quote(input),
        saveLead: saveLeadDep,
        saveQuoteId: saveQuoteIdDep,
        downloadFile: downloadFileDep,
        runtime,
        outputDir: cfeOutputDir,
        isCoworker,
      });

      registerPluginTool("Process CFE Receipt (Customer)", processCFEReceiptCustomerTool, {
        parseAndQuote: (input) => parseAndQuoteClient.quote(input),
        saveLead: saveLeadDep,
        saveQuoteId: saveQuoteIdDep,
        downloadFile: downloadFileDep,
        runtime,
        outputDir: cfeOutputDir,
      });

      registerPluginTool("Edit Quote", editQuoteTool, {
        editQuote: (input) => parseAndQuoteClient.editQuote(input),
        db,
        runtime,
        downloadFile: downloadFileDep,
        outputDir: cfeOutputDir,
      });
    } else {
      console.warn(
        "[whatsapp-lead-bot] process_cfe_receipt(_customer) and edit_quote disabled (requires SUPABASE_API_KEY)",
      );
    }

    // Register lead management tools
    registerPluginTool("Save Lead", saveLeadTool, { db, labelService, runtime });
    registerPluginTool("Get Lead", getLeadTool, { db });
    registerPluginTool("List Leads", listLeadsTool, { db });
    if (coworkerDirectory) {
      registerPluginTool("List Coworkers", listCoworkersTool, { directory: coworkerDirectory });
    }
    registerPluginTool("Get Followup Candidates", getFollowupCandidatesTool, { db });
    registerPluginTool("Handoff Lead", handoffLeadTool, {
      db,
      labelService,
      runtime,
      agentNotifier,
    });
    registerPluginTool("Block Lead", blockLeadTool, { db });
    registerPluginTool("Send Disqualification", sendDisqualificationTool, {
      db,
      labelService,
      runtime,
    });
    registerPluginTool("Send Receipt Request", sendReceiptRequestTool, { db, runtime });
    registerPluginTool("Send Handoff to Ale", sendHandoffToAleTool, {
      db,
      runtime,
      labelService,
      handoffManager,
      agentNumbers: config.agentNumbers,
    });
    registerPluginTool("Save Receipt Data", saveReceiptDataTool, { db });
    registerPluginTool("Sync Labels", syncLabelsTool, { db, labelService, runtime });
    registerPluginTool("Get Labels", getLabelsTool, { runtime });
    registerPluginTool("Create Label", createLabelTool, { runtime });
    registerPluginTool("Add Chat Label", addChatLabelTool, { runtime });
    registerPluginTool("Fetch WhatsApp History", whatsappHistoryFetchTool, { db });

    console.log("[whatsapp-lead-bot] Plugin registered successfully");

    // Store ALL WhatsApp messages (inbound + outbound + bot replies) via raw Baileys events.
    // The whatsapp plugin emits via a globalThis-backed Set under this Symbol; we subscribe
    // by adding our callback to the same Set so we receive events regardless of bundle boundaries.
    const RAW_MESSAGE_SUBSCRIBERS_KEY = Symbol.for("openclaw.whatsapp.rawMessageSubscribers");
    type RawMessageCallback = (accountId: string, msg: unknown) => void;
    type RawSubscribersState = { subscribers: Set<RawMessageCallback> };
    const rawG = globalThis as unknown as Record<symbol, RawSubscribersState | undefined>;
    if (!rawG[RAW_MESSAGE_SUBSCRIBERS_KEY]) {
      rawG[RAW_MESSAGE_SUBSCRIBERS_KEY] = { subscribers: new Set<RawMessageCallback>() };
    }
    const rawSubscribers = rawG[RAW_MESSAGE_SUBSCRIBERS_KEY].subscribers;

    const rawCallback: RawMessageCallback = (acctId, rawMsg) => {
      if (config.whatsappAccounts.length > 0 && !config.whatsappAccounts.includes(acctId)) {
        return;
      }
      const stored = parseRawMessage(rawMsg as Parameters<typeof parseRawMessage>[0]);
      if (!stored) {
        return;
      }
      // Eagerly populate peer_e164 when the chat_jid is already in @s.whatsapp.net form
      // (the digits before @ are the E.164 without the +).
      if (!stored.peer_e164 && stored.chat_jid.endsWith("@s.whatsapp.net")) {
        const digits = stored.chat_jid.split("@")[0];
        if (digits && /^\d+$/.test(digits)) {
          stored.peer_e164 = `+${digits}`;
        }
      }
      db.storeMessage(stored).catch((err) => {
        console.error("[lead-bot] Failed to store message:", err);
      });
    };
    rawSubscribers.add(rawCallback);
    const apiWithUnload = api as unknown as { onUnload?: (fn: () => void) => void };
    if (typeof apiWithUnload.onUnload === "function") {
      apiWithUnload.onUnload(() => rawSubscribers.delete(rawCallback));
    }
    console.log("[lead-bot] Raw WhatsApp message store registered");

    // Subscribe to enriched events (post-media-download) so we can backfill
    // media_path/media_type/media_filename on the existing message row.
    const ENRICHED_MESSAGE_SUBSCRIBERS_KEY = Symbol.for(
      "openclaw.whatsapp.enrichedMessageSubscribers",
    );
    type EnrichedWhatsAppMessage = {
      id: string;
      accountId: string;
      remoteJid: string;
      peerE164?: string;
      fromMe: boolean;
      mediaPath?: string;
      mediaType?: string;
      mediaFileName?: string;
    };
    type EnrichedMessageCallback = (msg: EnrichedWhatsAppMessage) => void;
    type EnrichedSubscribersState = { subscribers: Set<EnrichedMessageCallback> };
    const enrG = globalThis as unknown as Record<symbol, EnrichedSubscribersState | undefined>;
    if (!enrG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY]) {
      enrG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY] = { subscribers: new Set<EnrichedMessageCallback>() };
    }
    const enrichedSubscribers = enrG[ENRICHED_MESSAGE_SUBSCRIBERS_KEY].subscribers;
    const enrichedCallback: EnrichedMessageCallback = (msg) => {
      if (config.whatsappAccounts.length > 0 && !config.whatsappAccounts.includes(msg.accountId)) {
        return;
      }
      try {
        if (msg.mediaPath || msg.mediaType || msg.mediaFileName) {
          db.updateMessageMediaSync(msg.id, {
            mediaPath: msg.mediaPath ?? null,
            mediaType: msg.mediaType ?? null,
            mediaFileName: msg.mediaFileName ?? null,
          });
        }
        // Backfill peer_e164 for the entire chat_jid once we know the resolved E.164.
        // This is the LID → E.164 bridge: chat_jid stays the @lid form for stable joins,
        // peer_e164 makes the conversation queryable by phone number.
        if (msg.peerE164) {
          db.setPeerE164ByChatJidSync(msg.remoteJid, msg.peerE164);
        }
      } catch (err) {
        console.error("[lead-bot] Failed to update enriched fields on message:", err);
      }
    };
    enrichedSubscribers.add(enrichedCallback);
    if (typeof apiWithUnload.onUnload === "function") {
      apiWithUnload.onUnload(() => enrichedSubscribers.delete(enrichedCallback));
    }
    console.log("[lead-bot] Enriched WhatsApp media updater registered");

    // Register a DM history loader so the whatsapp plugin can inject conversation history
    // into the agent context for direct messages. Same Symbol-based contract.
    const DM_HISTORY_LOADER_KEY = Symbol.for("openclaw.whatsapp.dmHistoryLoader");
    type DmHistoryEntry = { sender: string; body: string; timestamp?: number; id?: string };
    type DmHistoryLoader = (params: {
      accountId: string;
      peerJid: string;
      peerE164: string;
    }) => DmHistoryEntry[] | undefined;
    type DmHistoryLoaderState = { loader: DmHistoryLoader | null };
    const histG = globalThis as unknown as Record<symbol, DmHistoryLoaderState | undefined>;
    if (!histG[DM_HISTORY_LOADER_KEY]) {
      histG[DM_HISTORY_LOADER_KEY] = { loader: null };
    }
    const dmLoader: DmHistoryLoader = ({ accountId, peerJid }) => {
      if (config.whatsappAccounts.length > 0 && !config.whatsappAccounts.includes(accountId)) {
        return undefined;
      }
      const rows = db.getMessagesSync(peerJid, 200);
      if (rows.length === 0) {
        return undefined;
      }
      return rows.map((r) => {
        const senderLabel = r.from_me === 1 ? "me" : (r.sender_jid ?? r.chat_jid);
        const mediaParts: string[] = [];
        if (r.media_type) {
          mediaParts.push(r.media_type);
        }
        if (r.media_filename) {
          mediaParts.push(r.media_filename);
        }
        if (r.media_size) {
          mediaParts.push(`${r.media_size} bytes`);
        }
        if (r.media_path) {
          mediaParts.push(`path: ${r.media_path}`);
        }
        const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join(", ")}]` : "";
        let body = (r.content ?? "") + mediaSuffix;
        if (r.reaction_emoji) {
          body = `[reaction ${r.reaction_emoji} on ${r.reaction_target_id ?? "?"}]`;
        } else if (r.revoked_target_id) {
          body = `[deleted message ${r.revoked_target_id}]`;
        } else if (r.edited_from_id) {
          body = `[edited ${r.edited_from_id}] ${body}`;
        }
        return {
          sender: senderLabel,
          body,
          timestamp: r.timestamp * 1000,
          id: r.id,
        };
      });
    };
    histG[DM_HISTORY_LOADER_KEY].loader = dmLoader;
    if (typeof apiWithUnload.onUnload === "function") {
      apiWithUnload.onUnload(() => {
        if (histG[DM_HISTORY_LOADER_KEY]?.loader === dmLoader) {
          histG[DM_HISTORY_LOADER_KEY].loader = null;
        }
      });
    }
    console.log("[lead-bot] DM history loader registered");
  },
};

export default plugin;
