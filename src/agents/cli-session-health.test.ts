import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatHealthCheckWarning, runCliSessionHealthCheck } from "./cli-session-health.js";

async function createAgentsDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-session-health-${label}-`));
}

async function writeAgent(params: {
  agentsDir: string;
  agentName: string;
  store: Record<string, unknown>;
  files: Array<{ name: string; bytes: number }>;
}): Promise<{ sessionsDir: string }> {
  const sessionsDir = path.join(params.agentsDir, params.agentName, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify(params.store, null, 2),
    "utf-8",
  );
  for (const file of params.files) {
    const filePath = path.join(sessionsDir, file.name);
    await fs.writeFile(filePath, "x".repeat(file.bytes), "utf-8");
  }
  return { sessionsDir };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("runCliSessionHealthCheck", () => {
  it("returns no findings when bindings already point at their largest file", async () => {
    const agentsDir = await createAgentsDir("healthy");
    cleanups.push(() => fs.rm(agentsDir, { recursive: true, force: true }));
    const { sessionsDir } = await writeAgent({
      agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:12345:thread:678": {
          sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
          sessionFile: path.join(
            agentsDir,
            "default",
            "sessions",
            "aaaaaaaa-1111-2222-3333-444444444444-topic-678.jsonl",
          ),
        },
      },
      files: [{ name: "aaaaaaaa-1111-2222-3333-444444444444-topic-678.jsonl", bytes: 500_000 }],
    });
    // Reference sessionsDir to satisfy linter about intentional usage.
    expect(sessionsDir).toContain("default");

    const result = await runCliSessionHealthCheck({ agentsDir });
    expect(result.findings).toEqual([]);
    expect(result.agentsScanned).toBeGreaterThan(0);
  });

  it("flags bindings pointing at a tiny sessionFile when a much bigger file exists for the same topic", async () => {
    const agentsDir = await createAgentsDir("amnesia");
    cleanups.push(() => fs.rm(agentsDir, { recursive: true, force: true }));
    const bigFile = "bbbbbbbb-1111-2222-3333-444444444444-topic-999.jsonl";
    const tinyFile = "cccccccc-1111-2222-3333-444444444444-topic-999.jsonl";
    await writeAgent({
      agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:12345:thread:999": {
          sessionId: "cccccccc-1111-2222-3333-444444444444",
          sessionFile: path.join(agentsDir, "default", "sessions", tinyFile),
        },
      },
      files: [
        { name: bigFile, bytes: 500_000 },
        { name: tinyFile, bytes: 600 },
      ],
    });

    const result = await runCliSessionHealthCheck({ agentsDir });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.topicId).toBe(999);
    expect(finding?.currentSessionId?.startsWith("cccccccc")).toBe(true);
    expect(finding?.bestSessionId.startsWith("bbbbbbbb")).toBe(true);
    expect(finding?.bestSizeBytes).toBe(500_000);
    expect(finding?.currentSizeBytes).toBe(600);
  });

  it("does not flag bindings with no stored history files for the topic", async () => {
    const agentsDir = await createAgentsDir("no-history");
    cleanups.push(() => fs.rm(agentsDir, { recursive: true, force: true }));
    await writeAgent({
      agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:12345:thread:42": {
          sessionId: "dddddddd-1111-2222-3333-444444444444",
        },
      },
      files: [],
    });

    const result = await runCliSessionHealthCheck({ agentsDir });
    expect(result.findings).toEqual([]);
  });

  it("returns empty when the agents directory does not exist", async () => {
    const result = await runCliSessionHealthCheck({
      agentsDir: path.join(os.tmpdir(), "openclaw-does-not-exist-" + Date.now()),
    });
    expect(result.findings).toEqual([]);
    expect(result.agentsScanned).toBe(0);
  });
});

describe("formatHealthCheckWarning", () => {
  it("returns undefined when no findings", () => {
    expect(
      formatHealthCheckWarning({ agentsScanned: 1, bindingsScanned: 0, findings: [] }),
    ).toBeUndefined();
  });

  it("formats a single-finding warning with the expected fields", () => {
    const message = formatHealthCheckWarning({
      agentsScanned: 1,
      bindingsScanned: 1,
      findings: [
        {
          agent: "default",
          sessionKey: "agent:default:telegram:default:direct:12345:thread:999",
          topicId: 999,
          currentSessionId: "cccccccc-1111-2222-3333-444444444444",
          currentSizeBytes: 600,
          bestSessionId: "bbbbbbbb-1111-2222-3333-444444444444",
          bestSizeBytes: 500_000,
          bestPath: "/tmp/best.jsonl",
          recoverableSiblings: 0,
        },
      ],
    });
    expect(message).toContain("1 binding");
    expect(message).toContain("topic=999");
    expect(message).toContain("cccccccc");
    expect(message).toContain("bbbbbbbb");
  });
});
