import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/**
 * Maximum number of historical session IDs retained in
 * `CliSessionBinding.previousSessionIds`. Ring-buffer cap — old entries past
 * this limit are dropped off the tail. Ten is enough to recover from a bad
 * rotation cycle without growing the store indefinitely.
 */
const PREVIOUS_SESSION_ID_HISTORY_LIMIT = 10;

function normalizePreviousSessionIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeOptionalString(entry);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
    if (out.length >= PREVIOUS_SESSION_ID_HISTORY_LIMIT) {
      break;
    }
  }
  return out.length > 0 ? out : undefined;
}

export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    const binding: CliSessionBinding = { sessionId: bindingSessionId };
    const authProfileId = normalizeOptionalString(fromBindings?.authProfileId);
    if (authProfileId) {
      binding.authProfileId = authProfileId;
    }
    const history = normalizePreviousSessionIds(
      (fromBindings as { previousSessionIds?: unknown })?.previousSessionIds,
    );
    if (history) {
      binding.previousSessionIds = history;
    }
    return binding;
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }

  // Preserve the previously-bound session ID in the history list whenever a
  // new session ID replaces a non-matching one. The live session is always
  // the head (`sessionId`); the tail is informational-only memory so we can
  // always recover from an unintended reset without scanning the filesystem.
  const existing = entry.cliSessionBindings?.[normalized];
  const existingSessionId = normalizeOptionalString(existing?.sessionId);
  const incomingHistory =
    normalizePreviousSessionIds((binding as { previousSessionIds?: unknown }).previousSessionIds) ??
    [];
  const storedHistory =
    normalizePreviousSessionIds(
      (existing as { previousSessionIds?: unknown } | undefined)?.previousSessionIds,
    ) ?? [];
  const mergedHistory: string[] = [];
  const pushUnique = (value: string | undefined) => {
    if (!value || value === trimmed || mergedHistory.includes(value)) {
      return;
    }
    mergedHistory.push(value);
  };
  for (const id of incomingHistory) {
    pushUnique(id);
  }
  if (existingSessionId && existingSessionId !== trimmed) {
    pushUnique(existingSessionId);
  }
  for (const id of storedHistory) {
    pushUnique(id);
  }
  const history = mergedHistory.slice(0, PREVIOUS_SESSION_ID_HISTORY_LIMIT);

  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(history.length > 0 ? { previousSessionIds: history } : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    delete entry.claudeCliSessionId;
  }
}

export function clearAllCliSessions(entry: SessionEntry): void {
  delete entry.cliSessionBindings;
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
}

/**
 * Resolve whether a stored CLI session binding should be reused on the next
 * turn. Contract: **always reuse a stored session ID when one exists.**
 *
 * Previous versions of this function gated reuse on a series of hash
 * comparisons (auth-epoch, extra-system-prompt, mcp-config). Those gates were
 * intended to detect "the environment changed, the resumed session might
 * surprise the model," but in practice they conflated identity (stable) with
 * ephemeral runtime state (rotating OAuth access tokens, ephemeral loopback
 * ports) and silently wiped agent conversation memory on every background
 * rotation. The corruption was compounded by the write path blindly
 * overwriting the stored session ID with the freshly-created one, making the
 * previous session unrecoverable from the store.
 *
 * The session ID itself is the source of truth. `claude --resume <uuid>`
 * loads the full past conversation regardless of current tool surface or
 * credential rotation — and if the resumed session is genuinely unusable
 * (auth revoked, session corrupted), Claude CLI will error out and the
 * runner will fall back to a fresh session naturally. Fail-open beats
 * fail-closed for session continuity.
 */
export function resolveCliSessionReuse(params: { binding?: CliSessionBinding }): {
  sessionId?: string;
} {
  const sessionId = normalizeOptionalString(params.binding?.sessionId);
  return sessionId ? { sessionId } : {};
}
