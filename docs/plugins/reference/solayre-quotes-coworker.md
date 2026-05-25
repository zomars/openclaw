---
summary: "Stateless CFE-receipt → solar-quote tools scoped to the solayre-coworker agent."
read_when:
  - You are wiring the solayre-coworker agent to generate quotes for its clients
  - You are auditing the siloed quote plugins
title: "Solayre Quotes Coworker plugin"
---

# Solayre Quotes Coworker plugin

CFE-receipt → solar-quote tooling for the `solayre-coworker` agent. The
coworker forwards a CFE receipt + the client's phone number; the plugin
parses via Supabase `parse-and-quote`, downloads the quote PDF, and
delivers it to the client phone.

Stateless: no leads DB, no hooks, no shared modules with its sister
`solayre-quotes-leads` (intentional physical clone — keep them independent).

## Distribution

- Package: `@openclaw/solayre-quotes-coworker`
- Install route: included in OpenClaw

## Agent scoping

Strict opt-in via the gateway's plugin scoping. Wire it as:

```json
{
  "plugins": {
    "allow": ["solayre-quotes-coworker"],
    "entries": {
      "solayre-quotes-coworker": {
        "enabled": true,
        "allowAgents": ["solayre-coworker"]
      }
    }
  }
}
```

## Tools

| Tool                                           | Purpose                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `solayre_quotes_coworker__process_cfe_receipt` | Parse a CFE receipt + send the quote PDF + summary to the coworker-supplied `clientPhone`. Requires `clientPhone` (E.164 without `+`). |
| `solayre_quotes_coworker__edit_quote`          | Revise an existing quote (panels, totalInvestment, targetCoverage, clientInfo) and redeliver to `clientPhone`.                         |

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
