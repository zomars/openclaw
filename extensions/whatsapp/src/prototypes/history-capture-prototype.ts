/**
 * PROTOTYPE - wipe me.
 *
 * Run with:
 *   pnpm prototype:whatsapp-history
 *
 * This terminal app simulates the Option B design: the base WhatsApp channel
 * persists history from Baileys upserts plus deterministic outbound writes.
 */

import readline from "node:readline";
import {
  createInitialCaptureState,
  messagesMissingIfRawOnly,
  queryByPeer,
  reduceCaptureState,
  summarizeState,
  type CaptureAction,
  type CaptureState,
} from "./history-capture-model.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const PEER = "+526671234567";
const CHAT = "526671234567@s.whatsapp.net";
const LID_CHAT = "111222333@lid";

let state = createInitialCaptureState();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

render();
rl.setPrompt("> ");
rl.prompt();

rl.on("line", (line) => {
  const command = line.trim().toLowerCase();
  if (command === "q" || command === "quit" || command === "exit") {
    rl.close();
    return;
  }

  const actions = actionForCommand(command);
  if (!actions) {
    state = {
      ...state,
      notes: [`Unknown command: ${line}`, ...state.notes.slice(0, 3)],
    };
  } else {
    for (const action of actions) {
      state = reduceCaptureState(state, action);
    }
  }

  render();
  rl.prompt();
});

function actionForCommand(command: string): CaptureAction[] | null {
  switch (command) {
    case "":
    case "t":
      return [{ type: "tick" }];
    case "r":
      return [{ type: "reset" }];
    case "i":
      return [
        {
          type: "baileys-upsert",
          accountId: "default",
          chatJid: CHAT,
          messageId: nextId("in"),
          peerE164: PEER,
          fromMe: false,
          body: "Cliente: quiero una cotizacion.",
        },
      ];
    case "w":
      return [
        {
          type: "baileys-upsert",
          accountId: "default",
          chatJid: CHAT,
          messageId: nextId("web"),
          peerE164: PEER,
          fromMe: true,
          body: "Asesor por WhatsApp Web: ya te atiendo personalmente.",
        },
      ];
    case "o":
      return [
        {
          type: "deterministic-outbound",
          accountId: "default",
          chatJid: CHAT,
          messageId: nextId("out"),
          peerE164: PEER,
          body: "OpenClaw outbound: Permiteme un momento, te confirmo con un asesor.",
        },
      ];
    case "e": {
      const id = nextId("out");
      return [
        {
          type: "deterministic-outbound",
          accountId: "default",
          chatJid: CHAT,
          messageId: id,
          peerE164: PEER,
          body: "OpenClaw outbound con eco: envio confirmado.",
        },
        {
          type: "baileys-upsert",
          accountId: "default",
          chatJid: CHAT,
          messageId: id,
          peerE164: PEER,
          fromMe: true,
          body: "OpenClaw outbound con eco: envio confirmado.",
        },
      ];
    }
    case "l":
      return [
        {
          type: "baileys-upsert",
          accountId: "default",
          chatJid: LID_CHAT,
          messageId: nextId("lid"),
          fromMe: false,
          body: "Cliente en chat LID: aqui esta mi recibo.",
        },
        {
          type: "enriched-upsert",
          accountId: "default",
          chatJid: LID_CHAT,
          messageId: lastId("lid"),
          peerE164: PEER,
          mediaPath: "/tmp/openclaw/artifacts/cfe.jpg",
        },
      ];
    case "h":
      return [
        {
          type: "history-sync",
          accountId: "default",
          chatJid: CHAT,
          messageId: nextId("hist"),
          peerE164: PEER,
          fromMe: false,
          body: "History sync: mensaje antiguo recuperado al conectar.",
          timestampMs: state.nowMs - 86_400_000,
        },
      ];
    default:
      return null;
  }
}

function render(): void {
  console.clear();
  const summary = summarizeState(state);
  const peerMessages = queryByPeer(state, PEER);
  const rawOnlyMissing = messagesMissingIfRawOnly(state);

  console.log(`${BOLD}WhatsApp History Capture Prototype${RESET}`);
  console.log(
    `${DIM}Question: can the base WhatsApp channel own capture, including handoff/outbound?${RESET}`,
  );
  console.log("");
  console.log(`${BOLD}State${RESET}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log(`${BOLD}Messages for ${PEER}${RESET}`);
  if (peerMessages.length === 0) {
    console.log(`${DIM}(none)${RESET}`);
  }
  for (const message of peerMessages.slice(-8)) {
    const when = new Date(message.timestampMs).toISOString();
    console.log(
      `${message.direction.padEnd(8)} ${message.messageId.padEnd(10)} ${when} ${message.sources.join("+")}`,
    );
    console.log(`  ${message.body || DIM + "(no body yet)" + RESET}`);
    if (message.mediaPath) {
      console.log(`  ${DIM}media: ${message.mediaPath}${RESET}`);
    }
  }
  console.log("");
  console.log(`${BOLD}Would be missing if we relied on raw upserts only${RESET}`);
  console.log(
    rawOnlyMissing.length
      ? rawOnlyMissing
          .map((message) => `${message.messageId}: outbound has no Baileys echo source`)
          .join("\n")
      : `${DIM}(none yet)${RESET}`,
  );
  console.log("");
  console.log(`${BOLD}Notes${RESET}`);
  for (const note of state.notes.slice(0, 4)) {
    console.log(`- ${note}`);
  }
  console.log("");
  console.log(`${BOLD}Commands${RESET}`);
  console.log(
    "[i] inbound  [w] WhatsApp Web handoff  [o] outbound no echo  [e] outbound echo  [l] LID+media  [h] history sync  [r] reset  [q] quit",
  );
}

const counters = new Map<string, number>();

function nextId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

function lastId(prefix: string): string {
  return `${prefix}-${String(counters.get(prefix) ?? 1).padStart(3, "0")}`;
}
