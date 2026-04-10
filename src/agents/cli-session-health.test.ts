import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing__,
  formatHealthCheckWarning,
  runCliSessionHealthCheck,
} from "./cli-session-health.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-session-health-${label}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes a synthetic Claude CLI session file with the topic metadata
 * embedded the same way the real runtime writes it: a `queue-operation`
 * record whose `content` field contains a markdown code block of JSON
 * including `"topic_id": "<tid>"`. The embedded JSON is stringified,
 * so the inner quotes end up escaped as `\"topic_id\": \"<tid>\"` in
 * the outer JSON line — this is exactly the format the regex in the
 * canary has to handle.
 */
async function writeClaudeSessionFile(params: {
  projectDir: string;
  sessionId: string;
  topicIds: readonly number[];
  padToBytes?: number;
}): Promise<string> {
  const filePath = path.join(params.projectDir, `${params.sessionId}.jsonl`);
  const contextLines = params.topicIds.map((tid) => {
    const contextJson = JSON.stringify({ message_id: "1", topic_id: String(tid) }, null, 2);
    return JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-04-10T18:24:43.322Z",
      sessionId: params.sessionId,
      content: `Conversation info:\n\`\`\`json\n${contextJson}\n\`\`\`\n`,
    });
  });
  let body = `${contextLines.join("\n")}\n`;
  if (params.padToBytes && body.length < params.padToBytes) {
    body += "x".repeat(params.padToBytes - body.length);
  }
  await fs.writeFile(filePath, body, "utf-8");
  return filePath;
}

async function writeAgentStore(params: {
  agentsDir: string;
  agentName: string;
  store: Record<string, unknown>;
}): Promise<string> {
  const dir = path.join(params.agentsDir, params.agentName, "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(params.store, null, 2), "utf-8");
  return storePath;
}

async function createFixture(label: string): Promise<{
  agentsDir: string;
  claudeProjectsDir: string;
  projectDir: string;
}> {
  const root = await createTempDir(label);
  const agentsDir = path.join(root, "agents");
  const claudeProjectsDir = path.join(root, "claude-projects");
  const projectDir = path.join(claudeProjectsDir, "-Users-test--openclaw-workspace");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  return { agentsDir, claudeProjectsDir, projectDir };
}

describe("extractTopicIdsFromContent", () => {
  it("extracts topic_id from a raw JSON object", () => {
    const ids = __testing__.extractTopicIdsFromContent('{"topic_id": "42"}');
    expect([...ids]).toEqual([42]);
  });

  it("extracts topic_id when the JSON is nested inside a stringified content field", () => {
    const embedded = JSON.stringify({
      content: 'Conversation info:\n```json\n{\n  "topic_id": "25123"\n}\n```\n',
    });
    const ids = __testing__.extractTopicIdsFromContent(embedded);
    expect([...ids]).toEqual([25123]);
  });

  it("extracts multiple distinct topic_ids from the same blob", () => {
    const content = '{"topic_id":"1"} some text {"topic_id":"2"}';
    expect([...__testing__.extractTopicIdsFromContent(content)].toSorted((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it("returns no ids for content that has no topic reference", () => {
    expect(__testing__.extractTopicIdsFromContent("{}").size).toBe(0);
  });
});

describe("extractTopicIdFromKey", () => {
  it("pulls the trailing numeric id off a telegram session key", () => {
    expect(
      __testing__.extractTopicIdFromKey(
        "agent:default:telegram:default:direct:1324919825:thread:1324919825:25123",
      ),
    ).toBe(25123);
  });

  it("returns undefined for keys with no trailing numeric id", () => {
    expect(__testing__.extractTopicIdFromKey("agent:default:main")).toBeUndefined();
  });
});

describe("runCliSessionHealthCheck", () => {
  it("returns no findings when every binding points at its largest recoverable Claude CLI session", async () => {
    const fx = await createFixture("healthy");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "aaaaaaaa-0000-0000-0000-000000000001",
      topicIds: [100],
      padToBytes: 500_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:100": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "aaaaaaaa-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toEqual([]);
    expect(result.topicsWithHistory).toBe(1);
    expect(result.claudeSessionFilesScanned).toBe(1);
  });

  it("flags a binding whose current Claude CLI session is dramatically smaller than the best recoverable one for the same topic", async () => {
    // This is the exact failure mode the user hit: the binding points at
    // a ~30 KB fresh session that was created after a silent reset, while
    // a ~600 KB session with the real conversation sits unused in the
    // Claude CLI project directory.
    const fx = await createFixture("amnesiac");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "bbbbbbbb-0000-0000-0000-000000000001",
      topicIds: [200],
      padToBytes: 600_000,
    });
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "cccccccc-0000-0000-0000-000000000001",
      topicIds: [200],
      padToBytes: 30_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:200": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "cccccccc-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.topicId).toBe(200);
    expect(finding?.currentSessionId?.startsWith("cccccccc")).toBe(true);
    expect(finding?.currentFileExists).toBe(true);
    expect(finding?.currentSizeBytes).toBeGreaterThanOrEqual(30_000);
    expect(finding?.bestSessionId.startsWith("bbbbbbbb")).toBe(true);
    expect(finding?.bestSizeBytes).toBeGreaterThanOrEqual(600_000);
    expect(finding?.recoverableSiblings).toBe(1);
  });

  it("flags a binding whose currently-bound sessionId no longer has any Claude CLI file for the topic", async () => {
    // When the bound sessionId does not appear in the topic index at all,
    // `currentFileExists` is false and the finding fires regardless of
    // size ratio — the binding is unambiguously stale.
    const fx = await createFixture("missing");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "dddddddd-0000-0000-0000-000000000001",
      topicIds: [300],
      padToBytes: 50_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:300": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "eeeeeeee-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.currentFileExists).toBe(false);
    expect(finding?.currentSizeBytes).toBe(0);
    expect(finding?.bestSessionId.startsWith("dddddddd")).toBe(true);
  });

  it("does not flag bindings for topics with no Claude CLI history at all", async () => {
    // A topic with no recoverable file is not recoverable; never fire a
    // finding in that case, even if the binding has a stale sessionId.
    const fx = await createFixture("no-history");
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:400": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "ffffffff-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toEqual([]);
  });

  it("does not flag healthy active topics where the best file is the current file", async () => {
    const fx = await createFixture("best-is-current");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "11111111-0000-0000-0000-000000000001",
      topicIds: [500],
      padToBytes: 200_000,
    });
    // An older, smaller sibling for the same topic must NOT cause a warning
    // when the current binding is already on the bigger file.
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "22222222-0000-0000-0000-000000000001",
      topicIds: [500],
      padToBytes: 10_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:500": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "11111111-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toEqual([]);
  });

  it("scans multiple agents and reports findings per-agent", async () => {
    const fx = await createFixture("multi-agent");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "11111111-0000-0000-0000-000000000002",
      topicIds: [600],
      padToBytes: 400_000,
    });
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "22222222-0000-0000-0000-000000000002",
      topicIds: [600],
      padToBytes: 20_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:600": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "22222222-0000-0000-0000-000000000002" },
          },
        },
      },
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "hank",
      store: {
        "agent:hank:telegram:default:direct:1:thread:600": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "11111111-0000-0000-0000-000000000002" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.agent).toBe("default");
    expect(result.agentsScanned).toBe(2);
  });

  it("gracefully skips unreadable project subdirectories", async () => {
    const fx = await createFixture("unreadable");
    await writeClaudeSessionFile({
      projectDir: fx.projectDir,
      sessionId: "55555555-0000-0000-0000-000000000001",
      topicIds: [700],
      padToBytes: 100_000,
    });
    // Simulate an entry in the claude-projects dir that is not a directory
    // (e.g. a stray file) to confirm it does not crash the walk.
    await fs.writeFile(path.join(fx.claudeProjectsDir, "not-a-dir"), "unrelated", "utf-8");

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.topicsWithHistory).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("returns empty when the Claude projects directory does not exist", async () => {
    const fx = await createFixture("no-claude");
    await fs.rm(fx.claudeProjectsDir, { recursive: true, force: true });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:999": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "00000000-0000-0000-0000-000000000099" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toEqual([]);
    expect(result.topicsWithHistory).toBe(0);
    expect(result.claudeSessionFilesScanned).toBe(0);
  });

  it("returns empty when the agents directory does not exist", async () => {
    const result = await runCliSessionHealthCheck({
      agentsDir: path.join(os.tmpdir(), `openclaw-health-missing-${Date.now()}`),
      claudeProjectsDir: path.join(os.tmpdir(), `openclaw-health-missing-${Date.now()}-claude`),
    });
    expect(result.findings).toEqual([]);
    expect(result.agentsScanned).toBe(0);
  });
});

describe("formatHealthCheckWarning", () => {
  it("returns undefined when there are no findings", () => {
    expect(
      formatHealthCheckWarning({
        agentsScanned: 1,
        bindingsScanned: 0,
        claudeSessionFilesScanned: 0,
        topicsWithHistory: 0,
        findings: [],
      }),
    ).toBeUndefined();
  });

  it("formats a single-finding warning and marks missing sessionFiles", () => {
    const message = formatHealthCheckWarning({
      agentsScanned: 1,
      bindingsScanned: 1,
      claudeSessionFilesScanned: 2,
      topicsWithHistory: 1,
      findings: [
        {
          agent: "default",
          sessionKey: "agent:default:telegram:default:direct:1:thread:700",
          topicId: 700,
          currentSessionId: "cccccccc-1111-2222-3333-444444444444",
          currentSizeBytes: 0,
          currentFileExists: false,
          bestSessionId: "bbbbbbbb-1111-2222-3333-444444444444",
          bestSizeBytes: 500_000,
          bestFilePath: "/tmp/ignored.jsonl",
          recoverableSiblings: 0,
        },
      ],
    });
    expect(message).toContain("1 binding");
    expect(message).toContain("topic=700");
    expect(message).toContain("cccccccc");
    expect(message).toContain("bbbbbbbb");
    expect(message).toContain("(missing)");
  });
});
