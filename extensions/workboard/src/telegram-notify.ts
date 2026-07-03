// Workboard plugin module implements Telegram event notification behavior.
import type { OpenClawPluginApi } from "../api.js";
import type { WorkboardCard, WorkboardEvent } from "./types.js";

const DEFAULT_TELEGRAM_TARGET = "telegram:1324919825:topic:36311";
const EXCLUDED_EVENT_KINDS = new Set<WorkboardEvent["kind"]>(["heartbeat"]);

function compact(value: unknown, max = 220): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function boardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function newestComment(card: WorkboardCard): string | undefined {
  return card.metadata?.comments?.at(-1)?.body;
}

function newestNotification(card: WorkboardCard): string | undefined {
  return card.metadata?.notifications?.at(-1)?.message;
}

function newestProof(card: WorkboardCard): string | undefined {
  const proof = card.metadata?.proof?.at(-1);
  return proof
    ? compact(proof.label ?? proof.command ?? proof.url ?? proof.note ?? proof.status)
    : undefined;
}

function newestWorkerLog(card: WorkboardCard): string | undefined {
  return card.metadata?.workerLogs?.at(-1)?.message;
}

function formatWorkboardTelegramMessage(card: WorkboardCard, event: WorkboardEvent): string {
  const title = `${card.title} (${card.id.slice(0, 8)})`;
  const board = boardId(card);
  if (event.kind === "moved") {
    return `Workboard: status\n${board}: ${title}\n${event.fromStatus ?? "?"} -> ${
      event.toStatus ?? "?"
    }`;
  }
  if (event.kind === "comment_added") {
    return `Workboard: comment\n${board}: ${title}\n${compact(newestComment(card))}`;
  }
  if (event.kind === "notification") {
    return `Workboard: notification\n${board}: ${title}\n${compact(newestNotification(card))}`;
  }
  if (event.kind === "proof_added") {
    return `Workboard: proof\n${board}: ${title}\n${compact(newestProof(card))}`;
  }
  if (event.kind === "orchestration") {
    return `Workboard: worker\n${board}: ${title}\n${compact(newestWorkerLog(card) ?? event.kind)}`;
  }
  return `Workboard: ${event.kind}\n${board}: ${title}`;
}

export function createWorkboardTelegramNotifier(api: OpenClawPluginApi) {
  const target =
    process.env.OPENCLAW_WORKBOARD_TELEGRAM_NOTIFY_TARGET?.trim() || DEFAULT_TELEGRAM_TARGET;
  return async (card: WorkboardCard, event: WorkboardEvent): Promise<void> => {
    if (EXCLUDED_EVENT_KINDS.has(event.kind)) {
      return;
    }
    try {
      const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
      if (!adapter?.sendText) {
        api.logger.warn("workboard telegram notify skipped: telegram outbound adapter unavailable");
        return;
      }
      await adapter.sendText({
        cfg: api.config,
        to: target,
        text: formatWorkboardTelegramMessage(card, event),
        accountId: "default",
      });
    } catch (error) {
      api.logger.warn(
        `workboard telegram notify failed event=${event.kind} card=${card.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
