# WhatsApp Lead Bot Prototypes

## Event Webhook Prototype

Question: can a narrow signed event intake replace long-poll completion checks for slow Solayre quote/calculation requests?

Run:

```bash
node --import tsx extensions/whatsapp-lead-bot/src/prototypes/event-webhook-prototype.ts
```

Current answer: yes, the shape works if public ingest only accepts signed typed events, records them idempotently, and dispatches internally async. Polling should remain as a fallback for missing events.

Validated cases:

- Missing signature is rejected before dispatch.
- Signed `calculation.completed` marks the matching quote job delivered.
- Retrying the same `event_id` does not deliver twice.
- Unknown `request_id` becomes a rejected/dead-letter event.
- Stale signatures are rejected with a replay window.

Next absorption path:

- Move the envelope parser and HMAC verifier into production code.
- Persist `event_store` in SQLite instead of memory.
- Add a gateway route/proxy path for `/hooks/openclaw-events/solayre`.
- Teach `parse-and-quote` to receive a callback URL and emit `calculation.completed` / `calculation.failed`.
- Keep `QuoteDeliveryWorker` polling as fallback until event reliability is proven.
