# Incomplete Receipt Handling

## Problem

When a customer sends a partial/cropped photo of their CFE receipt (missing the top section with RPU, tariff, service number, and customer name), the Supabase Edge Function `parse-and-quote` crashes with:

```
Cannot read properties of undefined (reading 'tariffType')
```

This propagates as `WORKER_ERROR` and the bot retries 120 times before giving up, with no useful feedback to the customer.

## Solution (Two Layers)

### Layer 1: Supabase Edge Function (`parse-and-quote`)

**File:** `supabase/functions/parse-and-quote/index.ts` (not in this repo)

After OCR parsing, validate that required fields were extracted before attempting to calculate a quote:

```typescript
const REQUIRED_FIELDS = ["rpu", "tariffType", "serviceNumber", "customerName", "annualKwh"];
const missing = REQUIRED_FIELDS.filter((f) => !parsed[f]);
if (missing.length > 0) {
  return {
    status: "error",
    error: {
      code: "incomplete_receipt",
      error: `Missing fields: ${missing.join(", ")}. The photo does not cover the full receipt.`,
      action: "request_full_photo",
    },
  };
}
```

This replaces the current crash with a clean, actionable error code.

### Layer 2: Bot (whatsapp-lead-bot) — Implemented

**Files modified:**

- `src/cfe/parse-and-quote-client.ts` — Error propagation now includes the detail message
- `src/cfe/quote-delivery-worker.ts` — Detects `incomplete_receipt` errors and sends a specific message to the customer

**Behavior:**

1. Worker detects `incomplete_receipt` (or `tariffType` / `Cannot read properties of undefined` in the error string)
2. Marks the job as failed (terminal — no retries)
3. Sends a specific message to the customer asking for a full photo
4. Does NOT notify agents (no human intervention needed)

**Customer message:**

> Gracias por enviar su recibo, pero la foto solo muestra una parte.
> Necesito ver la parte de arriba del recibo donde aparecen:
>
> - Su nombre completo
> - El RPU (numero de registro)
> - La tarifa (1, 1A, DAC, etc.)
> - El numero de servicio
>
> Podria tomar una foto donde se vea COMPLETO el recibo?

## Deployment Order

1. Deploy the Supabase Edge Function change first (Layer 1)
2. Deploy the bot changes (Layer 2) — already implemented and tested

The bot changes work with the current error format too (detects `tariffType` / `Cannot read properties of undefined` in the error string), so they provide value even without the Edge Function change.
