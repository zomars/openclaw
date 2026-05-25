---
summary: "AI-powered lead qualification bot for WhatsApp with admin commands, rate limiting, and follow-ups."
read_when:
  - You are installing, configuring, or auditing the whatsapp-lead-bot plugin
  - You need to understand which WhatsApp messages this plugin processes vs. ignores
title: "WhatsApp Lead Bot plugin"
---

# WhatsApp Lead Bot plugin

Lead-pipeline plugin for WhatsApp: qualification, 3-layer rate limiting,
handoff orchestration, lead-state tracking, scoring, label management, and
admin commands.

Quote-generation tools live in dedicated sister plugins
(`solayre-quotes-coworker`, `solayre-quotes-leads`) — this plugin only owns
the bot-initiated CFE receipt flow via `process_lead_cfe_receipt`.

## Distribution

- Package: `@openclaw/whatsapp-lead-bot`
- Install route: included in OpenClaw

## Agent scoping

This plugin is **strict opt-in** via `plugins.entries.whatsapp-lead-bot.allowAgents`.
Set it to the single agent that should drive the lead pipeline; the gateway
filters every hook (`message_received`, `message_sending`, `message_sent`,
`before_tool_call`, `before_prompt_build`) so unrelated agents — including
new ones added later — see nothing from this plugin.

```json
{
  "plugins": {
    "entries": {
      "whatsapp-lead-bot": {
        "enabled": true,
        "allowAgents": ["solayre-leads"]
      }
    }
  }
}
```

## Admin commands

Admin commands (`/status`, `/block`, `/unblock`, `/handoff`, `/clear-limit`,
`/recent`, `/rate-status`, `/reset-breaker`, `/help`) are restricted to
**self-chat**: the inbound message must come from the connected device
messaging the bot's own number (`metadata.sentByAccountOwner === true` and
`from === to`). `agentNumbers` is for outbound notifications only and is no
longer a trusted input channel.

## Tools

| Tool                                           | Purpose                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `block_lead`                                   | Mark a lead blocked.                                                                                           |
| `save_lead`                                    | Upsert a lead row. Used after a quote is generated to persist `quote_id` / `receipt_data`.                     |
| `get_lead`                                     | Read a single lead.                                                                                            |
| `list_leads`                                   | List leads with status/score filters.                                                                          |
| `get_followup_candidates`                      | Eligible leads for follow-up automation.                                                                       |
| `handoff_lead`                                 | Mark handed off, log handoff event, notify agents.                                                             |
| `send_disqualification`                        | Send the canonical disqualification message + mark lead.                                                       |
| `send_handoff_to_ale`                          | Acknowledge customer + notify the handoff target.                                                              |
| `send_receipt_request`                         | Ask the lead for their CFE receipt.                                                                            |
| `process_lead_cfe_receipt`                     | Bot-initiated CFE receipt → quote → delivery + lead persistence (renamed from `process_cfe_receipt_customer`). |
| `save_receipt_data`                            | Persist parsed receipt fields onto the lead row.                                                               |
| `sync_labels`                                  | Recompute lead scores + sync WhatsApp labels.                                                                  |
| `add_chat_label`, `create_label`, `get_labels` | WhatsApp label primitives.                                                                                     |
| `whatsapp_history_fetch`                       | Pull a peer's WhatsApp history into the bot's view.                                                            |

## Configuration

| Key                                                  | Type     | Notes                                                                    |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `enabled`                                            | boolean  | Master toggle.                                                           |
| `whatsappAccounts`                                   | string[] | WhatsApp account ids this bot serves.                                    |
| `agentNumbers`                                       | string[] | Phones that receive bot alerts (outbound only).                          |
| `dryRunPrefixes`                                     | string[] | Phone prefixes that skip real delivery while still running the pipeline. |
| `agentId`                                            | string   | Agent id for session-key construction.                                   |
| `dbPath`                                             | string   | SQLite path; defaults to `${stateDir}/whatsapp-lead-bot/leads.db`.       |
| `rateLimit.*`                                        | object   | Per-lead + global limits + circuit breaker.                              |
| `followup.*`                                         | object   | Follow-up scheduler.                                                     |
| `qualificationPrompt`                                | string   | Override the qualification LLM prompt.                                   |
| `autoHandoffWhenQualified`                           | boolean  | Auto-trigger handoff once a lead is qualified.                           |
| `notifyNewLeads`, `notifyQualified`, `notifyHandoff` | boolean  | Notification toggles.                                                    |
| `labels.*`                                           | object   | WhatsApp label-name overrides for scores/statuses.                       |
| `parseAndQuoteUrl`, `editQuoteUrl`                   | string   | Supabase endpoints.                                                      |

The previous coworker-aware fields (`coworkerAgentId`, `delegatedPeers`,
`openclawConfigPath`, `list_coworkers` tool) are gone. The gateway's
`allowAgents` scoping replaces them — peers routed to other agents never
reach this plugin.

## Hooks

- `message_received` — pipeline entry; runs only when the message routes to an
  agent in `allowAgents`.
- `message_sending` — detects human takeover via WhatsApp Web.
- `message_sent` — bookkeeping.
- `before_tool_call` — attribution override + violation tracker + pricing guardrail.
- `before_prompt_build` — injects lead context into the agent prompt.
