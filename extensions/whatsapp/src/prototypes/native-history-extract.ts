/**
 * PROTOTYPE - wipe me.
 *
 * Experimental native WhatsApp/Baileys history extractor.
 *
 * This connects with a cloned auth directory, listens for native history events,
 * filters one peer, and writes JSONL. It never sends chat messages.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChildLogger, toPinoLikeLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "../session.runtime.js";
import { toWhatsappJid } from "../text-runtime.js";

type Args = {
  peer?: string;
  account: string;
  authDir?: string;
  out?: string;
  timeoutMs: number;
  fullSync: boolean;
  listIds: boolean;
  requestCount?: number;
  oldestId?: string;
  oldestTs?: number;
  oldestFromMe: boolean;
};

type CapturedNativeMessage = {
  source: "messages.upsert" | "messaging-history.set";
  account: string;
  remoteJid: string | null;
  id: string | null;
  fromMe: boolean | null;
  timestamp: number | null;
  text: string | null;
  messageType: string | null;
  raw: unknown;
};

const args = parseArgs(process.argv.slice(2));
if (!args.peer && !args.listIds) {
  console.error(usage());
  process.exit(2);
}

const peerJid = args.peer ? toWhatsappJid(args.peer) : null;
const authDir = args.authDir ?? defaultAuthDir(args.account);
const outputPath =
  args.out ??
  path.join(
    "/tmp/openclaw/artifacts",
    `whatsapp-native-history-${safeName(peerJid ?? "all")}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
const idsOutputPath = outputPath.replace(/\.jsonl$/i, ".ids.json");
const scratchAuthDir = path.join(
  "/tmp/openclaw/artifacts",
  `whatsapp-native-auth-${args.account}-${Date.now()}`,
);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.rm(scratchAuthDir, { recursive: true, force: true });
await fs.cp(authDir, scratchAuthDir, { recursive: true });

const captured: CapturedNativeMessage[] = [];
const logger = toPinoLikeLogger(
  getChildLogger({ module: "whatsapp-native-history-prototype" }),
  "silent",
);
const { state } = await useMultiFileAuthState(scratchAuthDir);
const { version } = await fetchLatestBaileysVersion();
const sock = makeWASocket({
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger),
  },
  version,
  logger,
  printQRInTerminal: false,
  browser: ["openclaw", "history-prototype", "0"],
  markOnlineOnConnect: false,
  syncFullHistory: args.fullSync,
});

sock.ev.on("messages.upsert", ({ messages }) => {
  for (const message of messages ?? []) {
    maybeCapture("messages.upsert", message);
  }
});

sock.ev.on("messaging-history.set", ({ messages, syncType, progress }) => {
  console.error(
    `[native-history] history chunk syncType=${String(syncType)} progress=${String(progress)} messages=${messages.length}`,
  );
  for (const message of messages ?? []) {
    maybeCapture("messaging-history.set", message);
  }
});

sock.ev.on("connection.update", (update) => {
  if (update.connection) {
    console.error(`[native-history] connection=${update.connection}`);
  }
});

await waitForOpen(args.timeoutMs);

if (args.oldestId && args.oldestTs) {
  if (!peerJid) {
    throw new Error("--oldest-id/--oldest-ts requires --peer");
  }
  console.error(
    `[native-history] requesting ${args.requestCount ?? 50} messages before ${args.oldestId} in ${peerJid}`,
  );
  await sock.fetchMessageHistory?.(
    args.requestCount ?? 50,
    { remoteJid: peerJid, id: args.oldestId, fromMe: args.oldestFromMe },
    args.oldestTs,
  );
}

await delay(args.timeoutMs);
await writeJsonl(outputPath, captured);
if (args.listIds) {
  await fs.writeFile(
    idsOutputPath,
    JSON.stringify(buildIdIndex(captured), null, 2) + "\n",
    "utf-8",
  );
}
sock.end(undefined);
console.log(
  JSON.stringify(
    {
      peerJid,
      outputPath,
      idsOutputPath: args.listIds ? idsOutputPath : null,
      count: captured.length,
    },
    null,
    2,
  ),
);

function maybeCapture(
  source: CapturedNativeMessage["source"],
  message: {
    key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null };
    messageTimestamp?: unknown;
    message?: Record<string, unknown> | null;
  },
): void {
  const remoteJid = message.key?.remoteJid ?? null;
  if (peerJid && remoteJid !== peerJid) {
    return;
  }
  const capturedMessage: CapturedNativeMessage = {
    source,
    account: args.account,
    remoteJid,
    id: message.key?.id ?? null,
    fromMe: message.key?.fromMe ?? null,
    timestamp: normalizeTimestamp(message.messageTimestamp),
    text: extractText(message.message ?? undefined),
    messageType: message.message
      ? (Object.keys(message.message).find((key) => key !== "messageContextInfo") ?? null)
      : null,
    raw: message,
  };
  captured.push(capturedMessage);
  console.error(
    `[native-history] captured ${source} ${capturedMessage.id ?? "(no-id)"} ${capturedMessage.text ?? "(no text)"}`,
  );
}

function buildIdIndex(rows: CapturedNativeMessage[]): Array<{
  remoteJid: string;
  count: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sampleText: string | null;
  newestMessageId: string | null;
}> {
  const byJid = new Map<string, CapturedNativeMessage[]>();
  for (const row of rows) {
    if (!row.remoteJid) continue;
    byJid.set(row.remoteJid, [...(byJid.get(row.remoteJid) ?? []), row]);
  }
  return [...byJid.entries()]
    .map(([remoteJid, messages]) => {
      const timestamps = messages
        .map((message) => message.timestamp)
        .filter((timestamp): timestamp is number => typeof timestamp === "number");
      const sorted = [...messages].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      return {
        remoteJid,
        count: messages.length,
        firstTimestamp: timestamps.length ? Math.min(...timestamps) : null,
        lastTimestamp: timestamps.length ? Math.max(...timestamps) : null,
        sampleText: sorted.find((message) => message.text)?.text ?? null,
        newestMessageId: sorted.find((message) => message.id)?.id ?? null,
      };
    })
    .sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0));
}

function extractText(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const ext = message.extendedTextMessage as Record<string, unknown> | undefined;
  const img = message.imageMessage as Record<string, unknown> | undefined;
  const vid = message.videoMessage as Record<string, unknown> | undefined;
  const doc = message.documentMessage as Record<string, unknown> | undefined;
  return (
    (message.conversation as string | undefined) ??
    (ext?.text as string | undefined) ??
    (img?.caption as string | undefined) ??
    (vid?.caption as string | undefined) ??
    (doc?.caption as string | undefined) ??
    null
  );
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (
    value &&
    typeof value === "object" &&
    "low" in value &&
    typeof (value as { low: unknown }).low === "number"
  ) {
    return (value as { low: number }).low;
  }
  return null;
}

async function waitForOpen(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WhatsApp socket open")),
      timeoutMs,
    );
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function writeJsonl(filePath: string, rows: CapturedNativeMessage[]): Promise<void> {
  await fs.writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
  );
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    account: "default",
    timeoutMs: 30_000,
    fullSync: false,
    listIds: false,
    oldestFromMe: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--peer":
        parsed.peer = requireValue(arg, next);
        i++;
        break;
      case "--account":
        parsed.account = requireValue(arg, next);
        i++;
        break;
      case "--auth-dir":
        parsed.authDir = requireValue(arg, next);
        i++;
        break;
      case "--out":
        parsed.out = requireValue(arg, next);
        i++;
        break;
      case "--timeout-ms":
        parsed.timeoutMs = Number(requireValue(arg, next));
        i++;
        break;
      case "--full-sync":
        parsed.fullSync = true;
        break;
      case "--list-ids":
        parsed.listIds = true;
        break;
      case "--request-count":
        parsed.requestCount = Number(requireValue(arg, next));
        i++;
        break;
      case "--oldest-id":
        parsed.oldestId = requireValue(arg, next);
        i++;
        break;
      case "--oldest-ts":
        parsed.oldestTs = Number(requireValue(arg, next));
        i++;
        break;
      case "--oldest-from-me":
        parsed.oldestFromMe = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return parsed;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function defaultAuthDir(account: string): string {
  return path.join(os.homedir(), ".openclaw", "credentials", "whatsapp", account);
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(): string {
  return `Usage:
  pnpm prototype:whatsapp-native-history -- --account solayre --full-sync --list-ids
  pnpm prototype:whatsapp-native-history -- --peer <phone|jid> [--account solayre] [--full-sync]
  pnpm prototype:whatsapp-native-history -- --peer <phone|jid> --oldest-id <msg-id> --oldest-ts <epoch-seconds> [--oldest-from-me]

Notes:
  - This is a throwaway prototype.
  - It connects read-only with a cloned auth dir and writes JSONL to /tmp/openclaw/artifacts.
  - --list-ids writes a grouped *.ids.json file with observed remoteJids.
  - On-demand fetch requires an anchor message id/timestamp for the target chat.`;
}
