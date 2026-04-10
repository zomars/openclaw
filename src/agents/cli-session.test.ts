import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  hashCliSessionText,
  resolveCliSessionReuse,
  setCliSessionBinding,
} from "./cli-session.js";

describe("cli-session helpers", () => {
  it("persists binding metadata alongside legacy session ids", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };

    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(entry.cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
  });

  it("keeps legacy bindings reusable until richer metadata is persisted", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };

    expect(resolveCliSessionReuse({ binding: getCliSessionBinding(entry, "claude-cli") })).toEqual({
      sessionId: "legacy-session",
    });
  });

  it("invalidates legacy bindings when auth, prompt, or MCP state changes", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionIds: { "claude-cli": "legacy-session" },
      claudeCliSessionId: "legacy-session",
    };
    const binding = getCliSessionBinding(entry, "claude-cli");

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        extraSystemPromptHash: "prompt-hash",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("invalidates reuse when stored auth profile or prompt shape changes", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:personal",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-profile" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-b",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-b",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "system-prompt" });
    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-b",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("does not treat model changes as a session mismatch", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ sessionId: "cli-session-1" });
  });

  it("accepts a stored legacy mcpConfigHash on the first post-upgrade turn", () => {
    // Bindings persisted before the canonicalization fix hashed the raw
    // merged MCP config (including the ephemeral loopback port). Those
    // bindings must survive one turn under the new code — the current run
    // passes both the canonical hash and the legacy hash, and a match on
    // either is considered valid. The next call to `setCliSessionBinding`
    // will rewrite the stored hash to the canonical form.
    const binding = {
      sessionId: "cli-session-legacy",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "legacy-hash-with-port",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "canonical-hash-port-stripped",
        legacyMcpConfigHash: "legacy-hash-with-port",
      }),
    ).toEqual({ sessionId: "cli-session-legacy" });
  });

  it("still invalidates when neither canonical nor legacy mcpConfigHash matches", () => {
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "unrelated-stored-hash",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "auth-epoch-a",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "canonical-hash",
        legacyMcpConfigHash: "legacy-hash",
      }),
    ).toEqual({ invalidatedReason: "mcp" });
  });

  it("accepts a pre-fix binding whose authEpoch no longer matches (no version stamp)", () => {
    // Regression: bindings persisted before the identity-only auth-epoch
    // contract hashed rotating OAuth token material (access/refresh/expires),
    // so their stored `authEpoch` cannot be reproduced by the new code. The
    // absence of `authEpochVersion` means "legacy format", which must get a
    // one-time pass so existing sessions survive the upgrade. The following
    // turn rewrites the binding with `authEpochVersion: 2` and the new
    // stable hash, after which strict enforcement applies.
    const binding = {
      sessionId: "cli-session-legacy-auth",
      authProfileId: "anthropic:work",
      authEpoch: "old-hash-that-included-rotating-access-token",
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "new-stable-identity-only-hash",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ sessionId: "cli-session-legacy-auth" });
  });

  it("invalidates a new-format binding when authEpoch changes", () => {
    // Once a binding has `authEpochVersion: 2`, strict auth-epoch matching
    // applies. Under the new identity-only contract, any change here means
    // the user intentionally switched credentials (re-login, profile swap,
    // api key rotation), so invalidation is correct.
    const binding = {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
      authEpoch: "stable-hash-a",
      authEpochVersion: 2,
      extraSystemPromptHash: "prompt-a",
      mcpConfigHash: "mcp-a",
    };

    expect(
      resolveCliSessionReuse({
        binding,
        authProfileId: "anthropic:work",
        authEpoch: "stable-hash-b",
        extraSystemPromptHash: "prompt-a",
        mcpConfigHash: "mcp-a",
      }),
    ).toEqual({ invalidatedReason: "auth-epoch" });
  });

  it("persists and rehydrates authEpochVersion on round trip", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      authEpoch: "stable-hash",
      authEpochVersion: 2,
    });

    const hydrated = getCliSessionBinding(entry, "claude-cli");
    expect(hydrated?.authEpoch).toBe("stable-hash");
    expect(hydrated?.authEpochVersion).toBe(2);
  });

  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
    };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "claude-session" });
    setCliSessionBinding(entry, "codex-cli", { sessionId: "codex-session" });

    clearCliSession(entry, "codex-cli");
    expect(getCliSessionBinding(entry, "codex-cli")).toBeUndefined();
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("claude-session");

    clearAllCliSessions(entry);
    expect(entry.cliSessionBindings).toBeUndefined();
    expect(entry.cliSessionIds).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });

  it("hashes trimmed extra system prompts consistently", () => {
    expect(hashCliSessionText("  keep this  ")).toBe(hashCliSessionText("keep this"));
    expect(hashCliSessionText("")).toBeUndefined();
  });
});
