# Solayre Quotes (Coworker)

Stateless plugin scoped to the `solayre-coworker` agent via
`plugins.entries.solayre-quotes-coworker.allowAgents`. Pure tool surface — no
hooks, no DB.

Tools:
- `solayre_quotes_coworker__process_cfe_receipt` — parse a CFE PDF + deliver the quote back to the coworker by default; use `clientPhone` only for explicit direct-to-client delivery.
- `solayre_quotes_coworker__edit_quote` — revise an existing quote + redeliver to `clientPhone`.

Sister plugin: `extensions/solayre-quotes-leads/` (lead-flavored variant). The
two are intentional code clones; do not extract shared modules.
