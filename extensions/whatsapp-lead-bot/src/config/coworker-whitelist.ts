/**
 * Coworker whitelist: phone numbers the gateway routes to a coworker-facing
 * agent (e.g. `solayre-coworker`) instead of the lead-facing one. Used by tools
 * that persist into the leads table so they can skip writing rows keyed on a
 * coworker's own phone — those rows confuse later lookups by pairing the
 * coworker's number with whatever name was on their last referred receipt.
 *
 * The source of truth is `openclaw.json` → `bindings[*]` where `agentId`
 * matches the configured coworker agent and `match.peer.kind === "direct"`.
 */

import { normalizePhone } from "../utils/phone.js";

export interface CoworkerWhitelistSource {
  load(): Promise<Set<string>>;
}

interface BindingShape {
  agentId?: unknown;
  match?: {
    channel?: unknown;
    peer?: {
      id?: unknown;
      kind?: unknown;
    };
  };
}

interface OpenclawConfigShape {
  bindings?: unknown;
}

export interface ExtractOptions {
  agentId: string;
  channel?: string;
}

/**
 * Pure: pull the direct-peer phone numbers bound to `agentId` out of a parsed
 * openclaw.json. Returns canonical (digits-only, no leading "521") phones so
 * comparisons against runtime sender phones are exact regardless of formatting.
 *
 * When `channel` is provided, only bindings matching that channel count. Omit
 * to include every channel.
 */
export function extractCoworkerPhones(
  config: unknown,
  { agentId, channel }: ExtractOptions,
): string[] {
  const bindings = (config as OpenclawConfigShape | null | undefined)?.bindings;
  if (!Array.isArray(bindings)) {
    return [];
  }

  const phones = new Set<string>();
  for (const raw of bindings) {
    const binding = raw as BindingShape;
    if (binding?.agentId !== agentId) {
      continue;
    }
    if (channel && binding?.match?.channel !== channel) {
      continue;
    }
    if (binding?.match?.peer?.kind !== "direct") {
      continue;
    }
    const id = binding.match.peer.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    phones.add(normalizePhone(id));
  }
  return [...phones];
}
