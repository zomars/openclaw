# Conversation Ingest

`conversation-ingest` is a passive OpenClaw plugin that archives inbound channel messages from the existing `message_received` hook and exposes a retrieval tool for agents.

It is intentionally **not** a reply agent, router, or special listen-only channel mode. Channels continue to emit normal OpenClaw events; this plugin subscribes, stores, and makes the archive searchable.

## Enable it

The plugin is bundled with OpenClaw but disabled by default.

```bash
openclaw plugins enable conversation-ingest
openclaw plugins inspect conversation-ingest --runtime
```

A gateway restart or normal plugin reload may be required depending on the current runtime state.

## What it records

For each archive-worthy `message_received` event, the plugin writes one JSON object to an append-only JSONL file.

A message is archive-worthy when it has either:

- non-empty text content, or
- media metadata such as `mediaPath`, `mediaUrl`, `mediaType`, `mediaPaths`, `mediaUrls`, or `mediaTypes`

Empty messages without media metadata are skipped.

Stored fields include:

- `channelId`
- `accountId`
- `conversationId`
- `sessionKey`
- `messageId`
- `senderId`
- `from` / `to`
- `content`
- timestamps
- media references
- selected metadata
- raw event/context payload for auditability

## Storage location

Records are written under the OpenClaw state directory:

```text
<stateDir>/conversation-ingest/ingested_messages.jsonl
```

In a standard local setup this resolves to:

```text
~/.openclaw/conversation-ingest/ingested_messages.jsonl
```

## Retrieval tool

The plugin registers one agent tool:

```text
search_ingested_messages
```

Parameters:

| Parameter | Type   | Description                                                                |
| --------- | ------ | -------------------------------------------------------------------------- |
| `query`   | string | Text to search. Omit to return recent messages matching the other filters. |
| `chat`    | string | Conversation/chat id, sender id, recipient id, or session key substring.   |
| `account` | string | Channel account id, for example `default` or `solayre`.                    |
| `channel` | string | Channel id, for example `whatsapp`, `telegram`, or `slack`.                |
| `limit`   | number | Maximum results. Defaults to `20`; capped at `100`.                        |

Example tool input:

```json
{
  "channel": "whatsapp",
  "account": "solayre",
  "chat": "521...",
  "query": "cotización",
  "limit": 10
}
```

The tool returns recent matching messages in chronological order, plus the archive path and result count.

## Design rules

- Use existing OpenClaw channel events and plugin enablement.
- Do not add bespoke ingest config modes.
- Do not introduce a `listen_only` routing concept for this feature.
- Keep ingest behavior in plugin code, not in special routing/config semantics.
- Keep agents responsible for reasoning and replies; this plugin only archives and retrieves.

## Verification

Useful focused checks while editing this plugin:

```bash
pnpm exec tsc --noEmit --pretty false --project extensions/conversation-ingest/tsconfig.json
pnpm vitest run extensions/conversation-ingest/src/store.test.ts src/hooks/message-hook-mappers.test.ts src/plugins/contracts/boundary-invariants.test.ts
pnpm plugins:inventory:check
```
