#!/usr/bin/env node
import { createHmac } from "node:crypto";

const DEFAULT_EVENT = {
  event_id: `evt_local_${Date.now()}`,
  type: "calculation.completed",
  source: "solayre.parse-and-quote",
  subject: "quote_request:req_local_test",
  occurred_at: new Date().toISOString(),
  payload: {
    request_id: "req_local_test",
    quote_id: "quote_local_test",
    quote_number: "SOL20260629-local",
    pdf_url: "https://solayre.lovable.app/quotes/SOL20260629-local.pdf",
    customer_name: "Cliente Prueba",
    service_number: "538220809404",
    summary: "11 paneles, 105.86% de cobertura, retorno estimado de 3.69 anos.",
    quote: {
      panel_count: 11,
      cash_price: 115577.55,
      financed_price: 212850,
      annual_savings: 31314.3,
      coverage_percent: 105.86,
      payback_years: 3.69,
      system_kw: 7.095,
    },
  },
};

function parseArgs(argv) {
  const args = {
    body: null,
    jsonOnly: false,
    secret: process.env.QUOTE_EVENT_WEBHOOK_SECRET ?? "whsec_local_test",
    timestamp: Date.now(),
    url: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === "--body") args.body = next();
    else if (arg === "--json-only") args.jsonOnly = true;
    else if (arg === "--secret") args.secret = next();
    else if (arg === "--timestamp") args.timestamp = Number(next());
    else if (arg === "--url") args.url = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.secret) {
    throw new Error("Missing secret. Set QUOTE_EVENT_WEBHOOK_SECRET or pass --secret.");
  }
  if (!Number.isFinite(args.timestamp)) {
    throw new Error("Invalid --timestamp");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: send-signed-quote-event.mjs [options]

Generate or POST a signed Solayre quote webhook event.

Options:
  --url <url>          POST to this webhook URL. If omitted, print curl only.
  --secret <secret>    HMAC signing secret (default: QUOTE_EVENT_WEBHOOK_SECRET or whsec_local_test)
  --body <json>        Event JSON string (default: realistic local completed event)
  --timestamp <ms>     Signature timestamp in milliseconds (default: now)
  --json-only          Print the JSON body and signature header as JSON
`);
}

function sign(rawBody, secret, timestamp) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const args = parseArgs(process.argv.slice(2));
const body = args.body ?? JSON.stringify(DEFAULT_EVENT);
const signature = sign(body, args.secret, args.timestamp);

if (args.jsonOnly) {
  console.log(
    JSON.stringify(
      {
        body: JSON.parse(body),
        headers: {
          "content-type": "application/json",
          "x-openclaw-signature": signature,
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!args.url) {
  console.log(
    [
      "curl -i",
      "-X POST",
      "-H 'content-type: application/json'",
      `-H ${shellQuote(`x-openclaw-signature: ${signature}`)}`,
      "--data-binary",
      shellQuote(body),
      "<WEBHOOK_URL>",
    ].join(" \\\n  "),
  );
  process.exit(0);
}

const response = await fetch(args.url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-openclaw-signature": signature,
  },
  body,
});
const text = await response.text();
console.log(`${response.status} ${response.statusText}`);
console.log(text);
process.exit(response.ok ? 0 : 1);
