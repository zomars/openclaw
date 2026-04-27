/**
 * WhatsApp Lead Bot Plugin
 *
 * AI-powered lead qualification bot for WhatsApp with admin commands,
 * rate limiting, and follow-ups.
 */

import os from "node:os";
import path from "node:path";
import { sendWebChannelMessage } from "../../src/plugins/runtime/runtime-web-channel-plugin.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { AdminCommandHandler } from "./src/admin/commands.js";
import { WhatsAppLeadBotConfigSchema } from "./src/config/schema.js";
import { withContext } from "./src/context.js";
import { SqliteDatabase } from "./src/database/connection.js";
import { HandoffManager } from "./src/handoff/manager.js";
import { HandoffInterceptor } from "./src/hooks/handoff-interceptor.js";
import { MessageQueue } from "./src/hooks/message-queue.js";
import { createMessageReceivedHandler } from "./src/hooks/message-received.js";
import { createMessageSendingHandler } from "./src/hooks/message-sending.js";
import { createMessageSentHandler } from "./src/hooks/message-sent.js";
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
import { calculateQuoteTool } from "./src/tools/calculate-quote.js";
import { downloadCFEReceiptTool } from "./src/tools/download-cfe-receipt.js";
import { getLeadTool } from "./src/tools/get-lead.js";
import { handoffLeadTool } from "./src/tools/handoff-lead.js";
import { addChatLabelTool, createLabelTool, getLabelsTool } from "./src/tools/label-ops.js";
import { listLeadsTool } from "./src/tools/list-leads.js";
import { parseCFEReceiptTool } from "./src/tools/parse-cfe-receipt.js";
import { saveLeadTool } from "./src/tools/save-lead.js";
import { saveReceiptDataTool } from "./src/tools/save-receipt-data.js";
import { syncLabelsTool } from "./src/tools/sync-labels.js";
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

    // CFE receipt parsing — always active when API key is available
    // API key: config > env var (same key used by calculate_quote)
    const cfeApiKey = config.receiptExtraction?.apiKey || process.env.SUPABASE_API_KEY;
    if (!cfeApiKey) {
      console.warn("[whatsapp-lead-bot] No SUPABASE_API_KEY — CFE receipt parsing disabled");
    }
    const cfeParseContext = cfeApiKey
      ? {
          apiKey: cfeApiKey,
          apiUrl: config.supabaseCfeBillUrl,
          db,
          maxAttempts: config.receiptExtraction?.maxAttemptsPerLead ?? 3,
        }
      : undefined;
    const mediaHandler = new MediaHandler({ cfeParseContext });
    const handoffInterceptor = new HandoffInterceptor({ agentNotifier, cfeParseContext });

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

    // Register CFE receipt parsing tool (always on when API key exists)
    if (cfeParseContext) {
      registerPluginTool("Parse CFE Receipt", parseCFEReceiptTool, cfeParseContext);
    }

    // Register calculate_quote tool (uses SUPABASE_API_KEY env var)
    const supabaseApiKey = process.env.SUPABASE_API_KEY;
    if (supabaseApiKey) {
      registerPluginTool("Calculate Quote", calculateQuoteTool, {
        apiKey: supabaseApiKey,
        apiUrl: config.supabaseQuoteUrl,
      });
    }

    // Register CFE receipt download tool (no external deps, just wraps Python script)
    registerPluginTool("Download CFE Receipt", downloadCFEReceiptTool, {});

    // Register lead management tools
    registerPluginTool("Save Lead", saveLeadTool, { db, labelService, runtime });
    registerPluginTool("Get Lead", getLeadTool, { db });
    registerPluginTool("List Leads", listLeadsTool, { db });
    registerPluginTool("Handoff Lead", handoffLeadTool, {
      db,
      labelService,
      runtime,
      agentNotifier,
    });
    registerPluginTool("Block Lead", blockLeadTool, { db });
    registerPluginTool("Save Receipt Data", saveReceiptDataTool, { db });
    registerPluginTool("Sync Labels", syncLabelsTool, { db, labelService, runtime });
    registerPluginTool("Get Labels", getLabelsTool, { runtime });
    registerPluginTool("Create Label", createLabelTool, { runtime });
    registerPluginTool("Add Chat Label", addChatLabelTool, { runtime });

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
        const mediaSuffix = r.media_type
          ? ` [${r.media_type}${r.media_filename ? `: ${r.media_filename}` : ""}${r.media_size ? `, ${r.media_size} bytes` : ""}]`
          : "";
        return {
          sender: senderLabel,
          body: (r.content ?? "") + mediaSuffix,
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
