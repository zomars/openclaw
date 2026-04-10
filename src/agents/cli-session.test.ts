import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAllCliSessions,
  clearCliSession,
  getCliSessionBinding,
  getCliSessionId,
  resolveCliSessionReuse,
  setCliSessionBinding,
  setCliSessionId,
} from "./cli-session.js";

describe("getCliSessionBinding", () => {
  it("returns undefined for entries without a CLI binding", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    expect(getCliSessionBinding(entry, "claude-cli")).toBeUndefined();
  });

  it("hydrates a binding with the stored sessionId and optional auth profile", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "claude-session",
          authProfileId: "anthropic:work",
        },
      },
    };
    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding).toEqual({
      sessionId: "claude-session",
      authProfileId: "anthropic:work",
    });
  });

  it("falls back to the legacy claudeCliSessionId when no binding is present", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      claudeCliSessionId: "legacy-session",
    };
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({ sessionId: "legacy-session" });
  });

  it("ignores pre-fix hash/gate fields when rehydrating a binding", () => {
    // Regression: bindings persisted by earlier builds carried `authEpoch`,
    // `mcpConfigHash`, `extraSystemPromptHash`, etc. The new contract drops
    // those gate fields entirely — hydrated bindings must not expose them,
    // even if the raw stored shape still has them from an older writer.
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "claude-session",
          authProfileId: "anthropic:work",
          // Legacy JSON fields: not present on the current type but older
          // writers may have left them in the raw store.
          ...({
            authEpoch: "stale-epoch",
            authEpochVersion: 2,
            mcpConfigHash: "stale-mcp",
            extraSystemPromptHash: "stale-prompt",
          } as Record<string, unknown>),
        },
      },
    };
    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding).toEqual({
      sessionId: "claude-session",
      authProfileId: "anthropic:work",
    });
  });

  it("hydrates previousSessionIds when present", () => {
    const entry: SessionEntry = {
      sessionId: "openclaw-session",
      updatedAt: Date.now(),
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "current-session",
          previousSessionIds: ["older-1", "older-2"],
        },
      },
    };
    expect(getCliSessionBinding(entry, "claude-cli")).toEqual({
      sessionId: "current-session",
      previousSessionIds: ["older-1", "older-2"],
    });
  });
});

describe("setCliSessionBinding", () => {
  it("writes the binding and maintains legacy mirrors", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "cli-session-1",
      authProfileId: "anthropic:work",
    });

    expect(entry.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "cli-session-1",
        authProfileId: "anthropic:work",
      },
    });
    expect(entry.cliSessionIds).toEqual({ "claude-cli": "cli-session-1" });
    expect(entry.claudeCliSessionId).toBe("cli-session-1");
  });

  it("ignores empty session IDs", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "   " });
    expect(entry.cliSessionBindings).toBeUndefined();
  });

  it("preserves the previous sessionId in previousSessionIds when replaced", () => {
    // Layer 2: a replaced sessionId is never silently discarded from the
    // store — it is retained in the history list so recovery from an
    // unintended reset never requires filesystem scanning.
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "session-A" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "session-B" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "session-C" });

    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding?.sessionId).toBe("session-C");
    expect(binding?.previousSessionIds).toEqual(["session-B", "session-A"]);
  });

  it("does not record a history entry when the sessionId is unchanged", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "session-A" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "session-A" });
    expect(getCliSessionBinding(entry, "claude-cli")?.previousSessionIds).toBeUndefined();
  });

  it("caps history at 10 entries", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    for (let i = 0; i < 15; i += 1) {
      setCliSessionBinding(entry, "claude-cli", { sessionId: `session-${i}` });
    }
    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding?.sessionId).toBe("session-14");
    expect(binding?.previousSessionIds?.length).toBe(10);
    expect(binding?.previousSessionIds?.[0]).toBe("session-13");
    expect(binding?.previousSessionIds?.[9]).toBe("session-4");
  });

  it("merges explicit incoming previousSessionIds with stored history", () => {
    // Recovery tooling can pre-populate the history list when rewriting a
    // binding (e.g. to restore a lost conversation by pointing at an older
    // sessionId while preserving the post-amnesia fresh one for reference).
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "fresh-session" });
    setCliSessionBinding(entry, "claude-cli", {
      sessionId: "recovered-session",
      previousSessionIds: ["fresh-session"],
    });
    const binding = getCliSessionBinding(entry, "claude-cli");
    expect(binding?.sessionId).toBe("recovered-session");
    expect(binding?.previousSessionIds).toEqual(["fresh-session"]);
  });

  it("deduplicates history entries across overlap with stored history", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionBinding(entry, "claude-cli", { sessionId: "a" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "b" });
    setCliSessionBinding(entry, "claude-cli", { sessionId: "a" });
    const binding = getCliSessionBinding(entry, "claude-cli");
    // History becomes ["b"] — "a" is the live session again (not in history);
    // "b" was the displaced value and comes from the stored history exactly once.
    expect(binding?.previousSessionIds).toEqual(["b"]);
  });
});

describe("resolveCliSessionReuse", () => {
  it("returns undefined when no binding is provided", () => {
    expect(resolveCliSessionReuse({ binding: undefined })).toEqual({});
  });

  it("returns undefined when the binding has no sessionId", () => {
    expect(resolveCliSessionReuse({ binding: { sessionId: "" } })).toEqual({});
  });

  it("always returns the stored sessionId when one is present", () => {
    // Contract: session identity is owned by the sessionId. `claude --resume`
    // will load the conversation regardless of current environment; if the
    // resume genuinely fails, the runner will fall back naturally. The
    // previous gate-based invalidation silently wiped agent memory whenever
    // any background state (OAuth tokens, MCP port) rotated, and is gone.
    expect(
      resolveCliSessionReuse({
        binding: { sessionId: "cli-session-1", authProfileId: "anthropic:work" },
      }),
    ).toEqual({ sessionId: "cli-session-1" });
  });
});

describe("clear helpers", () => {
  it("clears provider-scoped and global CLI session state", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
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
});

describe("setCliSessionId / getCliSessionId shortcuts", () => {
  it("round-trips through the binding", () => {
    const entry: SessionEntry = { sessionId: "openclaw-session", updatedAt: Date.now() };
    setCliSessionId(entry, "claude-cli", "cli-session-1");
    expect(getCliSessionId(entry, "claude-cli")).toBe("cli-session-1");
  });
});
