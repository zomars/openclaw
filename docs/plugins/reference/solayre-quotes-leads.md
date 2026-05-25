---
summary: "Stateless CFE-receipt → solar-quote tools scoped to the solayre-leads agent."
read_when:
  - You are wiring the solayre-leads agent for operator-driven quote generation
  - You are auditing the siloed quote plugins
title: "Solayre Quotes Leads plugin"
---

# Solayre Quotes Leads plugin

CFE-receipt → solar-quote tooling for the `solayre-leads` agent. The agent
(or operator) calls these tools to generate quotes for whichever lead it's
currently talking to. Stateless — the leads DB stays in `whatsapp-lead-bot`.

To persist `quote_id` / `receipt_data` onto the lead row after a quote, chain
`save_lead` (and optionally `save_receipt_data`) from `whatsapp-lead-bot`.

Sister plugin: `solayre-quotes-coworker`. The two are intentional physical
code clones; no shared modules.

## Distribution

- Package: `@openclaw/solayre-quotes-leads`
- Install route: included in OpenClaw

## Agent scoping

Strict opt-in via the gateway's plugin scoping. Wire it as:

```json
{
  "plugins": {
    "allow": ["solayre-quotes-leads"],
    "entries": {
      "solayre-quotes-leads": {
        "enabled": true,
        "allowAgents": ["solayre-leads"]
      }
    }
  }
}
```

## Tools

| Tool                                        | Purpose                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `solayre_quotes_leads__process_cfe_receipt` | Parse a CFE receipt + send the quote PDF + summary to the lead at `leadPhone`.                            |
| `solayre_quotes_leads__edit_quote`          | Revise an existing quote (panels, totalInvestment, targetCoverage, clientInfo) and redeliver to the lead. |

## Configuration

| Key                | Type     | Notes                                                  |
| ------------------ | -------- | ------------------------------------------------------ |
| `enabled`          | boolean  | Master toggle.                                         |
| `whatsappAccounts` | string[] | WhatsApp account id used to send quotes.               |
| `parseAndQuoteUrl` | string   | Supabase `parse-and-quote` endpoint.                   |
| `editQuoteUrl`     | string   | Supabase `calculate-quote` endpoint.                   |
| `mediaDir`         | string   | Directory where quote PDFs are staged before delivery. |

`SUPABASE_API_KEY` must be set in the environment; without it the plugin
logs a warning and registers no tools.

## Hooks

None. This plugin contributes tools only.
