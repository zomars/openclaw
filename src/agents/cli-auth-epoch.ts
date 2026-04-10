import crypto from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  type ClaudeCliCredential,
  type CodexCliCredential,
} from "./cli-credentials.js";

type CliAuthEpochDeps = {
  readClaudeCliCredentialsCached: typeof readClaudeCliCredentialsCached;
  readCodexCliCredentialsCached: typeof readCodexCliCredentialsCached;
  loadAuthProfileStoreForRuntime: typeof loadAuthProfileStoreForRuntime;
};

const defaultCliAuthEpochDeps: CliAuthEpochDeps = {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  loadAuthProfileStoreForRuntime,
};

const cliAuthEpochDeps: CliAuthEpochDeps = { ...defaultCliAuthEpochDeps };

export function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void {
  Object.assign(cliAuthEpochDeps, overrides);
}

export function resetCliAuthEpochTestDeps(): void {
  Object.assign(cliAuthEpochDeps, defaultCliAuthEpochDeps);
}

function hashCliAuthEpochPart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeUnknown(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// Identity-only encoders: hash the stable "which credential are we using"
// fingerprint, never the rotating bearer material (access/refresh/expires/token).
//
// OAuth access tokens rotate every ~hour on refresh, and Anthropic/OpenAI/etc.
// may also rotate refresh tokens on exchange. If any of those fields contribute
// to `authEpoch`, every background token rotation invalidates every persisted
// CLI session binding and wipes the agent's conversation memory — even though
// the underlying account is unchanged. The intent of `authEpoch` is to detect
// when the user swapped which credential they are using (logout/login, auth
// profile change, API key rotation), not when a short-lived token rotated
// behind the scenes. Keep only fields that move on explicit identity changes.
function encodeClaudeCredential(credential: ClaudeCliCredential): string {
  // Claude CLI credentials do not carry an explicit account identifier in
  // their parsed shape; `type` + `provider` is the most specific stable
  // fingerprint available. An oauth→token mechanism swap still flips the
  // hash; an explicit re-login with a different Anthropic account will not
  // (rare edge case; users can reset sessions manually if needed).
  return JSON.stringify([credential.type, credential.provider]);
}

function encodeCodexCredential(credential: CodexCliCredential): string {
  // Codex OAuth carries an optional `accountId` that provides per-account
  // granularity without touching rotating token material.
  return JSON.stringify([credential.type, credential.provider, credential.accountId ?? null]);
}

function encodeAuthProfileCredential(credential: AuthProfileCredential): string {
  switch (credential.type) {
    case "api_key":
      // API keys are user-supplied static values — hashing the key is safe
      // and correctly invalidates sessions on explicit rotation. `metadata`
      // is dropped because it may carry refresh-adjacent fields like cached
      // quotas or last-sync timestamps.
      return JSON.stringify([
        "api_key",
        credential.provider,
        credential.key ?? null,
        encodeUnknown(credential.keyRef),
        credential.email ?? null,
        credential.displayName ?? null,
      ]);
    case "token":
      // `token` and `expires` rotate on refresh; `tokenRef` is the stable
      // handle that only moves when the user re-points the credential.
      return JSON.stringify([
        "token",
        credential.provider,
        encodeUnknown(credential.tokenRef),
        credential.email ?? null,
        credential.displayName ?? null,
      ]);
    case "oauth":
      // Drop access/refresh/expires; keep every other field that could
      // distinguish one OAuth identity from another (clientId, email,
      // displayName, enterpriseUrl, projectId, accountId, managedBy).
      return JSON.stringify([
        "oauth",
        credential.provider,
        credential.clientId ?? null,
        credential.email ?? null,
        credential.displayName ?? null,
        credential.enterpriseUrl ?? null,
        credential.projectId ?? null,
        credential.accountId ?? null,
        credential.managedBy ?? null,
      ]);
  }
}

function getLocalCliCredentialFingerprint(provider: string): string | undefined {
  switch (provider) {
    case "claude-cli": {
      const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      return credential ? hashCliAuthEpochPart(encodeClaudeCredential(credential)) : undefined;
    }
    case "codex-cli": {
      const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
        ttlMs: 5000,
      });
      return credential ? hashCliAuthEpochPart(encodeCodexCredential(credential)) : undefined;
    }
    default:
      return undefined;
  }
}

function getAuthProfileCredential(
  store: AuthProfileStore,
  authProfileId: string | undefined,
): AuthProfileCredential | undefined {
  if (!authProfileId) {
    return undefined;
  }
  return store.profiles[authProfileId];
}

export async function resolveCliAuthEpoch(params: {
  provider: string;
  authProfileId?: string;
}): Promise<string | undefined> {
  const provider = params.provider.trim();
  const authProfileId = normalizeOptionalString(params.authProfileId);
  const parts: string[] = [];

  const localFingerprint = getLocalCliCredentialFingerprint(provider);
  if (localFingerprint) {
    parts.push(`local:${provider}:${localFingerprint}`);
  }

  if (authProfileId) {
    const store = cliAuthEpochDeps.loadAuthProfileStoreForRuntime(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    const credential = getAuthProfileCredential(store, authProfileId);
    if (credential) {
      parts.push(
        `profile:${authProfileId}:${hashCliAuthEpochPart(encodeAuthProfileCredential(credential))}`,
      );
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return hashCliAuthEpochPart(parts.join("\n"));
}
