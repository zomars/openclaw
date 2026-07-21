/**
 * Solayre Quotes (Coworker) — composition root.
 *
 * Stateless plugin. No hooks, no DB. Registers two tools that the
 * `solayre-coworker` agent uses to generate + deliver solar quotes for its
 * clients via the Supabase parse-and-quote endpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendWebChannelMessage } from "../../src/plugins/runtime/runtime-web-channel-plugin.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createParseAndQuoteClient } from "./src/cfe/parse-and-quote-client.js";
import { SolayreQuotesCoworkerConfigSchema } from "./src/config/schema.js";
import { createDownloader } from "./src/download.js";
import type { Runtime } from "./src/runtime.js";
import { editQuoteCoworkerTool } from "./src/tools/edit-quote.js";
import {
  searchPreviousQuotesCoworkerTool,
  sendPreviousQuotePdfCoworkerTool,
} from "./src/tools/previous-quote.js";
import { processCFEReceiptCoworkerTool } from "./src/tools/process-cfe-receipt.js";
import { createTerminalFailureGuard } from "./src/tools/terminal-failure-guard.js";

const plugin = {
  id: "solayre-quotes-coworker",
  name: "Solayre Quotes (Coworker)",
  description: "Stateless CFE-receipt → solar-quote tools scoped to the solayre-coworker agent.",
  configSchema: SolayreQuotesCoworkerConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = SolayreQuotesCoworkerConfigSchema.parse(api.pluginConfig);
    if (!config.enabled) {
      console.log("[solayre-quotes-coworker] disabled in config");
      return;
    }

    const apiKey = process.env.SUPABASE_API_KEY;
    if (!apiKey) {
      console.warn(
        "[solayre-quotes-coworker] SUPABASE_API_KEY missing — quote tools will not be registered",
      );
      return;
    }

    const stateDir = (api.runtime as { stateDir?: string })?.stateDir;
    const outputDir =
      config.mediaDir ??
      path.join(stateDir ?? os.homedir(), "solayre-quotes-coworker", "cfe-output");
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      console.error("[solayre-quotes-coworker] mkdir outputDir failed:", err);
    }

    const accountId = config.whatsappAccounts[0];
    const runtime: Runtime = {
      async sendMessage(to, content) {
        try {
          // Read live config when available so account credentials reflect any
          // mid-session edits; fall back to the activation-time snapshot.
          const cfg = (api.runtime.config?.current?.() ?? api.config) as Parameters<
            typeof sendWebChannelMessage
          >[2]["cfg"];
          await sendWebChannelMessage(to, content.text, {
            verbose: false,
            cfg,
            accountId,
          });
        } catch (err) {
          console.error("[solayre-quotes-coworker] sendMessage failed:", err);
          throw err;
        }
      },
      async sendAlert(text) {
        if (!config.alertTelegramChatId) {
          return;
        }
        const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
        if (!adapter?.sendText) {
          console.warn("[solayre-quotes-coworker] telegram alert adapter unavailable");
          return;
        }
        const cfg = (api.runtime.config?.current?.() ?? api.config) as typeof api.config;
        await adapter.sendText({
          cfg,
          to: config.alertTelegramChatId,
          text,
          ...(config.alertTelegramAccountId ? { accountId: config.alertTelegramAccountId } : {}),
          ...(config.alertTelegramThreadId != null
            ? { threadId: config.alertTelegramThreadId }
            : {}),
        });
      },
    };

    const parseAndQuoteClient = createParseAndQuoteClient({
      apiKey,
      apiUrl: config.parseAndQuoteUrl,
      editQuoteUrl: config.editQuoteUrl,
      searchQuotesUrl: config.searchQuotesUrl,
      sendQuotePdfUrl: config.sendQuotePdfUrl,
      timeoutMs: config.parseAndQuoteTimeoutMs,
    });
    const downloadFile = createDownloader({ apiKey });
    const terminalFailureGuard = createTerminalFailureGuard({
      terminalToolName: processCFEReceiptCoworkerTool.name,
    });
    api.on("before_tool_call", terminalFailureGuard.beforeToolCall);
    api.on("after_tool_call", terminalFailureGuard.afterToolCall);

    const registerTool = <TParams, TCtx>(
      label: string,
      tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        execute: (params: TParams, ctx: TCtx) => Promise<unknown>;
      },
      ctx: TCtx,
    ) => {
      api.registerTool({
        name: tool.name,
        label,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_id: string, params: TParams) => {
          const result = await tool.execute(params, ctx);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
      console.log(`[solayre-quotes-coworker] Registered tool: ${tool.name}`);
    };

    registerTool("Process CFE Receipt (Coworker)", processCFEReceiptCoworkerTool, {
      parseAndQuote: (input) => parseAndQuoteClient.quote(input),
      downloadFile,
      runtime,
      outputDir,
    });
    registerTool("Edit Quote (Coworker)", editQuoteCoworkerTool, {
      editQuote: (input) => parseAndQuoteClient.editQuote(input),
      downloadFile,
      runtime,
      outputDir,
    });
    registerTool("Search Previous Quotes (Coworker)", searchPreviousQuotesCoworkerTool, {
      searchQuotes: (input) => parseAndQuoteClient.searchQuotes(input),
      sendQuotePdf: (input) => parseAndQuoteClient.sendQuotePdf(input),
      downloadFile,
      runtime,
      outputDir,
    });
    registerTool("Send Previous Quote PDF (Coworker)", sendPreviousQuotePdfCoworkerTool, {
      searchQuotes: (input) => parseAndQuoteClient.searchQuotes(input),
      sendQuotePdf: (input) => parseAndQuoteClient.sendQuotePdf(input),
      downloadFile,
      runtime,
      outputDir,
    });

    console.log("[solayre-quotes-coworker] Plugin registered");
  },
};

export default plugin;
export { plugin };
