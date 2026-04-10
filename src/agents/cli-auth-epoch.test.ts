import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resetCliAuthEpochTestDeps,
  resolveCliAuthEpoch,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.js";

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
  });

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {},
      }),
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli" })).resolves.toBeUndefined();
    await expect(
      resolveCliAuthEpoch({
        provider: "google-gemini-cli",
        authProfileId: "google:work",
      }),
    ).resolves.toBeUndefined();
  });

  it("stays stable across claude cli oauth token refresh", async () => {
    // Regression: Claude CLI rotates access/refresh/expires on every token
    // refresh (~hourly). If the epoch hash included any of those fields, it
    // would flip every refresh and silently wipe the agent's conversation
    // memory under `reason=auth-epoch`. The hash must only track the stable
    // identity fingerprint.
    let credential = {
      type: "oauth" as const,
      provider: "anthropic" as const,
      access: "access-old",
      refresh: "refresh-old",
      expires: 1_000_000,
    };
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => credential,
    });

    const before = await resolveCliAuthEpoch({ provider: "claude-cli" });
    credential = {
      type: "oauth",
      provider: "anthropic",
      access: "access-new",
      refresh: "refresh-new",
      expires: 2_000_000,
    };
    const afterRefresh = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(before).toBeDefined();
    expect(afterRefresh).toBeDefined();
    expect(afterRefresh).toBe(before);
  });

  it("changes when claude cli switches between oauth and static token", async () => {
    // Swapping OAuth ↔ static token is an intentional identity change
    // (different login mechanism) and should invalidate the session.
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "oauth",
        provider: "anthropic",
        access: "access-a",
        refresh: "refresh-a",
        expires: 1,
      }),
    });
    const oauthEpoch = await resolveCliAuthEpoch({ provider: "claude-cli" });

    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        type: "token",
        provider: "anthropic",
        token: "token-a",
        expires: 1,
      }),
    });
    const tokenEpoch = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(oauthEpoch).toBeDefined();
    expect(tokenEpoch).toBeDefined();
    expect(tokenEpoch).not.toBe(oauthEpoch);
  });

  it("stays stable across auth profile oauth refresh", async () => {
    // Same contract for auth-profile stored OAuth credentials.
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-old",
          refresh: "refresh-old",
          expires: 1_000_000,
          email: "user@example.com",
          clientId: "client-a",
        },
      },
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const before = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-new",
          refresh: "refresh-new",
          expires: 2_000_000,
          email: "user@example.com",
          clientId: "client-a",
        },
      },
    };
    const afterRefresh = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(before).toBeDefined();
    expect(afterRefresh).toBeDefined();
    expect(afterRefresh).toBe(before);
  });

  it("changes when auth profile identity fields change", async () => {
    // Explicit identity rotation (different email, clientId, accountId)
    // should invalidate the session — that is the intended use of
    // `authEpoch`. This guards against an over-broad fix that would never
    // invalidate.
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-old",
          refresh: "refresh-old",
          expires: 1,
          email: "alice@example.com",
          clientId: "client-a",
        },
      },
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const beforeEmail = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:work": {
          type: "oauth",
          provider: "anthropic",
          access: "access-old",
          refresh: "refresh-old",
          expires: 1,
          email: "bob@example.com",
          clientId: "client-a",
        },
      },
    };
    const afterEmailChange = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:work",
    });

    expect(beforeEmail).toBeDefined();
    expect(afterEmailChange).toBeDefined();
    expect(afterEmailChange).not.toBe(beforeEmail);
  });

  it("stays stable across token-profile bearer rotation", async () => {
    // Static-token profile: `token` + `expires` rotate on re-fetch but the
    // stable `tokenRef` handle does not. Session identity follows the ref.
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:pat": {
          type: "token",
          provider: "anthropic",
          token: "bearer-old",
          tokenRef: { source: "env", provider: "default", id: "PAT_TOKEN" },
          expires: 1_000_000,
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const before = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:pat",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:pat": {
          type: "token",
          provider: "anthropic",
          token: "bearer-new",
          tokenRef: { source: "env", provider: "default", id: "PAT_TOKEN" },
          expires: 2_000_000,
          email: "user@example.com",
        },
      },
    };
    const afterRefresh = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:pat",
    });

    expect(before).toBeDefined();
    expect(afterRefresh).toBeDefined();
    expect(afterRefresh).toBe(before);
  });

  it("changes when an api_key is explicitly rotated", async () => {
    // API keys are user-supplied static values; an explicit rotation
    // is a legitimate identity change and should invalidate the session.
    let store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-old",
          email: "user@example.com",
        },
      },
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const before = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:api",
    });
    store = {
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-new",
          email: "user@example.com",
        },
      },
    };
    const afterRotation = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      authProfileId: "anthropic:api",
    });

    expect(before).toBeDefined();
    expect(afterRotation).toBeDefined();
    expect(afterRotation).not.toBe(before);
  });

  it("stays stable when codex local access/refresh rotate but accountId is unchanged", async () => {
    let access = "local-access-a";
    let refresh = "local-refresh-a";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access,
        refresh,
        expires: 1,
        accountId: "acct-1",
      }),
      loadAuthProfileStoreForRuntime: () => ({
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "profile-access-a",
            refresh: "profile-refresh-a",
            expires: 1,
            clientId: "client-a",
            email: "user@example.com",
          },
        },
      }),
    });

    const first = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });
    access = "local-access-b";
    refresh = "local-refresh-b";
    const second = await resolveCliAuthEpoch({
      provider: "codex-cli",
      authProfileId: "openai:work",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).toBe(first);
  });

  it("changes when codex accountId switches", async () => {
    let accountId: string | undefined = "acct-1";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => ({
        type: "oauth",
        provider: "openai-codex",
        access: "access",
        refresh: "refresh",
        expires: 1,
        accountId,
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "codex-cli" });
    accountId = "acct-2";
    const second = await resolveCliAuthEpoch({ provider: "codex-cli" });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});
