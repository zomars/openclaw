import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { JsonlIngestStore, SearchIngestedMessagesParams } from "./store.js";

export function createSearchIngestedMessagesTool(store: JsonlIngestStore): AnyAgentTool {
  return {
    name: "search_ingested_messages",
    label: "Search Ingested Messages",
    description:
      "Search passively archived channel messages. Filters by query text, chat/conversation id, account id, channel id, and limit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Text to search for. Omit to return recent messages matching the filters.",
        },
        chat: {
          type: "string",
          description: "Conversation/chat id, sender id, recipient id, or session key substring.",
        },
        account: {
          type: "string",
          description: "Channel account id filter, e.g. solayre or default.",
        },
        channel: {
          type: "string",
          description: "Channel id filter, e.g. whatsapp, telegram, slack.",
        },
        limit: {
          type: "number",
          description: "Maximum messages to return (default 20, max 100).",
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const result = await store.search((params ?? {}) as SearchIngestedMessagesParams);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
