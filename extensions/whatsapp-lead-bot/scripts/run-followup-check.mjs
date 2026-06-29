#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".openclaw/workspace-solayre-leads/data/leads.db");
const RECEIPT_FOLLOWUP_TEXT =
  "Hola, ¿pudo conseguir su recibo de CFE? Con él le preparo su cotización personalizada sin costo.";
const SURVEY_TEXT =
  "Hola, anteriormente intenté contactarle para brindarle información sobre paneles solares.\n\n" +
  "Antes de pausar su solicitud, me gustaría saber qué pasó.\n" +
  "Sin presión, solo para entender mejor su situación:\n\n" +
  "1. No he podido conseguir mi recibo CFE\n" +
  "2. No tengo capital disponible ahorita\n" +
  "3. Solo investigaba precios, no voy a instalar este año\n" +
  "4. Contácteme más adelante\n" +
  "5. Ya contraté con otra empresa\n\n" +
  "Solo responda con el número que aplique.";
const INSTAGRAM_TEXT =
  "Hola, espero que esté teniendo una excelente semana.\n\n" +
  "Le comparto nuestra red para que pueda seguir enterándose de nuestros programas y beneficios en paneles solares en Sinaloa:\n" +
  "https://www.instagram.com/p/DWCZT8wD8pL/";

function parseArgs(argv) {
  const args = {
    account: "solayre",
    channel: "whatsapp",
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
    json: false,
    limit: 5,
    maxAttempts: 3,
    minIdleMs: 3 * 24 * 60 * 60 * 1000,
    openclawBin: process.env.OPENCLAW_BIN ?? "openclaw",
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

    if (arg === "--account") args.account = next();
    else if (arg === "--channel") args.channel = next();
    else if (arg === "--db") args.dbPath = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--max-attempts") args.maxAttempts = Number(next());
    else if (arg === "--min-idle-ms") args.minIdleMs = Number(next());
    else if (arg === "--openclaw-bin") args.openclawBin = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const key of ["limit", "maxAttempts", "minIdleMs"]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) {
      throw new Error(`Invalid numeric option: ${key}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: run-followup-check.mjs [options]

Deterministic Solayre follow-up worker. Selects eligible leads, sends WhatsApp
follow-ups, updates local SQLite state, and prints an audit summary.

Options:
  --account <id>        WhatsApp account id (default: solayre)
  --channel <channel>   Message channel (default: whatsapp)
  --db <path>           Leads SQLite DB path
  --dry-run             Select and report without sending or updating DB
  --json                Print JSON summary
  --limit <n>           Max follow-up candidates (default: 5)
  --max-attempts <n>    Candidate attempt cap (default: 3)
  --min-idle-ms <n>     Minimum idle window (default: 3 days)
  --openclaw-bin <bin>  OpenClaw CLI binary (default: openclaw)
`);
}

function normalizePhone(phone) {
  return String(phone ?? "").replace(/^\+/, "");
}

function phoneForCli(phone) {
  const normalized = normalizePhone(phone);
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

function getFollowupCandidates(db, args, now) {
  const cutoff = now - args.minIdleMs;
  return db
    .prepare(
      `SELECT l.* FROM leads l
       WHERE l.score IN ('HOT', 'WARM')
         AND l.status IN ('new', 'qualifying')
         AND l.last_message_at < ?
         AND (l.follow_up_attempts IS NULL OR l.follow_up_attempts < ?)
         AND l.handed_off_at IS NULL
         AND l.blocked_at IS NULL
         AND l.rate_limited_at IS NULL
         AND l.receipt_data IS NULL
         AND l.annual_kwh IS NULL
         AND l.panels_quoted IS NULL
         AND l.quote_cash IS NULL
         AND l.quote_financed IS NULL
         AND l.quoted_at IS NULL
         AND LENGTH(REPLACE(l.phone_number, '+', '')) BETWEEN 10 AND 15
         AND REPLACE(l.phone_number, '+', '') GLOB '[0-9]*'
         AND REPLACE(l.phone_number, '+', '') NOT GLOB '*[^0-9]*'
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE REPLACE(m.peer_e164, '+', '') = REPLACE(l.phone_number, '+', '')
             AND m.from_me = 0
         )
         AND NOT EXISTS (
           SELECT 1 FROM pending_quote_jobs pqj
           WHERE REPLACE(pqj.customer_phone, '+', '') = REPLACE(l.phone_number, '+', '')
             AND pqj.status IN ('pending', 'delivered')
         )
       ORDER BY l.last_message_at ASC
       LIMIT ?`,
    )
    .all(cutoff, args.maxAttempts, args.limit);
}

function getInstagramCandidates(db, now) {
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT * FROM leads
       WHERE status = 'qualifying'
         AND score = 'HOT'
         AND survey_sent_at IS NOT NULL
         AND survey_sent_at < ?
         AND instagram_reminder_sent_at IS NULL
         AND handed_off_at IS NULL
         AND blocked_at IS NULL
       ORDER BY survey_sent_at ASC`,
    )
    .all(cutoff);
}

function sendMessage(args, lead, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      args.openclawBin,
      [
        "message",
        "send",
        "--channel",
        args.channel,
        "--account",
        args.account,
        "--target",
        phoneForCli(lead.phone_number),
        "--message",
        message,
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(`openclaw message send failed (${code}): ${stderr || stdout}`));
    });
  });
}

function enqueueLeadSnapshotSync(db, leadId) {
  const lead = db
    .prepare("SELECT id, phone_number, updated_at FROM leads WHERE id = ?")
    .get(leadId);
  if (!lead) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO crm_sync_outbox (
      event_type, aggregate_type, aggregate_id, idempotency_key, payload_json,
      status, attempts, next_attempt_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
    ON CONFLICT(idempotency_key) DO UPDATE SET
      event_type = excluded.event_type,
      aggregate_type = excluded.aggregate_type,
      aggregate_id = excluded.aggregate_id,
      payload_json = excluded.payload_json,
      status = 'pending',
      attempts = 0,
      next_attempt_at = excluded.next_attempt_at,
      last_error = NULL,
      updated_at = excluded.updated_at`,
  ).run(
    "lead_snapshot_changed",
    "lead",
    String(lead.id),
    `lead_snapshot:lead:${lead.id}`,
    JSON.stringify({
      leadId: lead.id,
      phoneNumber: lead.phone_number,
      updatedAt: lead.updated_at,
    }),
    now,
    now,
    now,
  );
}

function markFollowupSent(db, lead, sentAt) {
  const nextAttempts = Number(lead.follow_up_attempts ?? 0) + 1;
  const sentSurvey = Number(lead.follow_up_attempts ?? 0) >= 2;
  db.prepare(
    `UPDATE leads
     SET follow_up_sent_at = ?,
         follow_up_attempts = ?,
         survey_sent_at = CASE WHEN ? THEN ? ELSE survey_sent_at END,
         updated_at = ?
     WHERE id = ?`,
  ).run(sentAt, nextAttempts, sentSurvey ? 1 : 0, sentAt, sentAt, lead.id);
  enqueueLeadSnapshotSync(db, lead.id);
}

function markInstagramReminderSent(db, lead, sentAt) {
  db.prepare(
    `UPDATE leads
     SET instagram_reminder_sent_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(sentAt, sentAt, lead.id);
  enqueueLeadSnapshotSync(db, lead.id);
}

function followupMessageFor(lead) {
  return Number(lead.follow_up_attempts ?? 0) >= 2 ? SURVEY_TEXT : RECEIPT_FOLLOWUP_TEXT;
}

function printSummary(summary, json) {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Solayre follow-up worker completed in ${summary.durationMs}ms.`);
  console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
  console.log(`Follow-up candidates: ${summary.followup.candidates}`);
  console.log(`Follow-up sent: ${summary.followup.sent}`);
  console.log(`Instagram candidates: ${summary.instagram.candidates}`);
  console.log(`Instagram sent: ${summary.instagram.sent}`);
  if (summary.failures.length > 0) {
    console.log(`Failures: ${summary.failures.length}`);
    for (const failure of summary.failures) {
      console.log(`- ${failure.phone}: ${failure.error}`);
    }
  }
  if (summary.followup.sent === 0 && summary.instagram.sent === 0) {
    console.log("No messages sent: no eligible candidates, or this was a dry run.");
  }
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.dbPath);
  const summary = {
    dbPath: args.dbPath,
    dryRun: args.dryRun,
    durationMs: 0,
    failures: [],
    followup: { candidates: 0, sent: 0, leads: [] },
    instagram: { candidates: 0, sent: 0, leads: [] },
  };

  try {
    const now = Date.now();
    const candidates = getFollowupCandidates(db, args, now);
    summary.followup.candidates = candidates.length;

    for (const lead of candidates) {
      const entry = {
        id: lead.id,
        name: lead.name,
        phone: lead.phone_number,
        score: lead.score,
        status: lead.status,
        previousAttempts: Number(lead.follow_up_attempts ?? 0),
      };
      summary.followup.leads.push(entry);
      if (args.dryRun) continue;

      try {
        await sendMessage(args, lead, followupMessageFor(lead));
        const sentAt = Date.now();
        markFollowupSent(db, lead, sentAt);
        summary.followup.sent += 1;
      } catch (err) {
        summary.failures.push({
          phone: lead.phone_number,
          stage: "followup",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const instagramCandidates = getInstagramCandidates(db, Date.now());
    summary.instagram.candidates = instagramCandidates.length;
    for (const lead of instagramCandidates) {
      const entry = {
        id: lead.id,
        name: lead.name,
        phone: lead.phone_number,
        score: lead.score,
        status: lead.status,
      };
      summary.instagram.leads.push(entry);
      if (args.dryRun) continue;

      try {
        await sendMessage(args, lead, INSTAGRAM_TEXT);
        markInstagramReminderSent(db, lead, Date.now());
        summary.instagram.sent += 1;
      } catch (err) {
        summary.failures.push({
          phone: lead.phone_number,
          stage: "instagram",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    db.close();
  }

  summary.durationMs = Date.now() - startedAt;
  printSummary(summary, args.json);

  if (summary.failures.length > 0 && !args.dryRun) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
