# Solayre Quotes (Leads)

Stateless plugin scoped to the `solayre-leads` agent via
`plugins.entries.solayre-quotes-leads.allowAgents`. Pure tool surface — no
hooks, no DB.

Tools:
- `solayre_quotes_leads__process_cfe_receipt` — parse a CFE PDF + deliver the quote to the lead.
- `solayre_quotes_leads__edit_quote` — revise an existing quote + redeliver to the lead.

The leads DB stays in `whatsapp-lead-bot`. To persist `quote_id` /
`receipt_data` after a quote is generated, the agent should chain
`save_lead` (and optionally `save_receipt_data`) from `whatsapp-lead-bot`.

Sister plugin: `extensions/solayre-quotes-coworker/`. The two are intentional
code clones; do not extract shared modules.
