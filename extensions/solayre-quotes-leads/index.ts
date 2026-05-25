/**
 * Solayre Quotes (Leads) — composition root.
 *
 * Stateless. Registers two tools that the `solayre-leads` agent uses to
 * generate + deliver solar quotes to the lead it's currently talking to.
 * Lead-state persistence lives in `whatsapp-lead-bot` (save_lead /
 * save_receipt_data); this plugin does not touch the leads DB.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendWebChannelMessage } from "../../src/plugins/runtime/runtime-web-channel-plugin.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createParseAndQuoteClient } from "./src/cfe/parse-and-quote-client.js";
import { SolayreQuotesLeadsConfigSchema } from "./src/config/schema.js";
import { createDownloader } from "./src/download.js";
import type { Runtime } from "./src/runtime.js";
import { editQuoteLeadsTool } from "./src/tools/edit-quote.js";
import { processCFEReceiptLeadsTool } from "./src/tools/process-cfe-receipt.js";

const plugin = {
  id: "solayre-quotes-leads",
  name: "Solayre Quotes (Leads)",
  description: "Stateless CFE-receipt → solar-quote tools scoped to the solayre-leads agent.",
  configSchema: SolayreQuotesLeadsConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = SolayreQuotesLeadsConfigSchema.parse(api.pluginConfig);
    if (!config.enabled) {
      console.log("[solayre-quotes-leads] disabled in config");
      return;
    }

    const apiKey = process.env.SUPABASE_API_KEY;
    if (!apiKey) {
      console.warn("[solayre-quotes-leads] SUPABASE_API_KEY missing — tools not registered");
      return;
    }

    const stateDir = (api.runtime as { stateDir?: string })?.stateDir;
    const outputDir =
      config.mediaDir ?? path.join(stateDir ?? os.homedir(), "solayre-quotes-leads", "cfe-output");
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      console.error("[solayre-quotes-leads] mkdir outputDir failed:", err);
    }

    const accountId = config.whatsappAccounts[0];
    const runtime: Runtime = {
      async sendMessage(to, content) {
        try {
          const cfg = (api.runtime.config?.current?.() ?? api.config) as Parameters<
            typeof sendWebChannelMessage
          >[2]["cfg"];
          await sendWebChannelMessage(to, content.text, {
            verbose: false,
            cfg,
            accountId,
          });
        } catch (err) {
          console.error("[solayre-quotes-leads] sendMessage failed:", err);
        }
      },
    };

    const parseAndQuoteClient = createParseAndQuoteClient({
      apiKey,
      apiUrl: config.parseAndQuoteUrl,
      editQuoteUrl: config.editQuoteUrl,
    });
    const downloadFile = createDownloader({ apiKey });

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
      console.log(`[solayre-quotes-leads] Registered tool: ${tool.name}`);
    };

    registerTool("Process CFE Receipt (Lead)", processCFEReceiptLeadsTool, {
      parseAndQuote: (input) => parseAndQuoteClient.quote(input),
      downloadFile,
      runtime,
      outputDir,
    });
    registerTool("Edit Quote (Lead)", editQuoteLeadsTool, {
      editQuote: (input) => parseAndQuoteClient.editQuote(input),
      downloadFile,
      runtime,
      outputDir,
    });

    console.log("[solayre-quotes-leads] Plugin registered");
  },
};

export default plugin;
export { plugin };
