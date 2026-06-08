---
summary: "Passively archives channel messages from existing OpenClaw message hooks and exposes retrieval tools."
read_when:
  - You are installing, configuring, or auditing the conversation-ingest plugin
title: "Conversation Ingest plugin"
---

# Conversation Ingest plugin

Passively archives channel messages from existing OpenClaw message hooks and exposes retrieval tools.

## Distribution

- Package: `@openclaw/conversation-ingest`
- Install route: included in OpenClaw

## Surface

contracts: tools

## Purpose

Use this plugin when you want OpenClaw to keep a searchable passive archive of channel conversations without changing the reply pipeline.

It is **not**:

- a special channel routing mode
- a `listen_only` config primitive
- an agent that silently observes messages
- a replacement for normal agent reply behavior

The intended split is:

1. Channels emit normal `message_received` events.
2. `conversation-ingest` subscribes to those events.
3. The plugin stores archive-worthy message records.
4. Agents use `search_ingested_messages` when they need prior conversation context.

## Enable

```bash
openclaw plugins enable conversation-ingest
openclaw plugins inspect conversation-ingest --runtime
```

Depending on the current runtime state, a normal plugin reload or gateway restart may be needed before the hook/tool is active.

## Archive behavior

The plugin subscribes to the typed `message_received` hook and appends records to JSONL.

A message is archived when it has either:

- non-empty text content, or
- media metadata such as `mediaPath`, `mediaUrl`, `mediaType`, `mediaPaths`, `mediaUrls`, or `mediaTypes`

Empty messages with no media metadata are skipped.

## Storage

Records are written below OpenClaw's resolved state directory:

```text
<stateDir>/conversation-ingest/ingested_messages.jsonl
```

For a typical local install this is:

```text
~/.openclaw/conversation-ingest/ingested_messages.jsonl
```

The file is append-only JSONL: one JSON record per line.

## Search tool

Tool name:

```text
search_ingested_messages
```

Parameters:

| Parameter | Type   | Description                                                              |
| --------- | ------ | ------------------------------------------------------------------------ |
| `query`   | string | Text search. Omit to return recent messages matching filters.            |
| `chat`    | string | Conversation/chat id, sender id, recipient id, or session key substring. |
| `account` | string | Channel account id, for example `default` or `solayre`.                  |
| `channel` | string | Channel id, for example `whatsapp`, `telegram`, or `slack`.              |
| `limit`   | number | Max results. Defaults to `20`; capped at `100`.                          |

Example input:

```json
{
  "channel": "whatsapp",
  "account": "solayre",
  "chat": "521...",
  "query": "cotización",
  "limit": 10
}
```

The tool returns the archive path, result count, and matching messages. Results are selected newest-first internally, capped by `limit`, then returned in chronological order.

## Design constraints

Keep these constraints intact when modifying this plugin:

- Use existing OpenClaw routing/config/plugin primitives.
- Keep passive behavior in implementation code, not in a bespoke config layer.
- Do not introduce a new `listen_only` concept for ingestion.
- Do not make this an agent-framed observer.
- Do not let ingestion affect whether agents reply.

## Focused verification

```bash
pnpm exec tsc --noEmit --pretty false --project extensions/conversation-ingest/tsconfig.json
pnpm vitest run extensions/conversation-ingest/src/store.test.ts src/hooks/message-hook-mappers.test.ts src/plugins/contracts/boundary-invariants.test.ts
pnpm plugins:inventory:check
```
