import os from "node:os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createIngestedMessageRecord, defaultIngestPath, JsonlIngestStore } from "./src/store.js";
import { createSearchIngestedMessagesTool } from "./src/tool.js";

export default definePluginEntry({
  id: "conversation-ingest",
  name: "Conversation Ingest",
  description:
    "Passively archives channel messages from existing OpenClaw message hooks and exposes retrieval tools.",
  register(api) {
    const stateDir = api.runtime.state.resolveStateDir(process.env, os.homedir);
    const store = new JsonlIngestStore(defaultIngestPath(stateDir));

    api.on("message_received", async (event, ctx) => {
      const record = createIngestedMessageRecord(event, ctx);
      if (!record) {
        return;
      }
      try {
        await store.append(record);
      } catch (error) {
        api.logger.warn(`[conversation-ingest] failed to archive message: ${String(error)}`);
      }
    });

    api.registerTool(createSearchIngestedMessagesTool(store));
    api.logger.info(`[conversation-ingest] archiving messages to ${store.filePath}`);
  },
});
