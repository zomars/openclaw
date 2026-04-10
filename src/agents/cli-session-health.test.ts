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

type FieldMap = Record<string, string>;

/**
 * Writes a synthetic Claude CLI session file whose head contains a
 * `queue-operation` record with the given metadata fields embedded in
 * the `content` string exactly the way the real runtime writes them:
 * a markdown code block containing stringified JSON inside a JSON
 * content field (so the inner quotes end up escaped). This is the format
 * the canary's head-scan regex has to tolerate.
 */
async function writeClaudeSessionFile(params: {
  projectDir: string;
  sessionId: string;
  fields: readonly FieldMap[];
  padToBytes?: number;
}): Promise<string> {
  const filePath = path.join(params.projectDir, `${params.sessionId}.jsonl`);
  const contextLines = params.fields.map((fieldMap) => {
    const contextJson = JSON.stringify(fieldMap, null, 2);
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
  project(name: string): Promise<string>;
}> {
  const root = await createTempDir(label);
  const agentsDir = path.join(root, "agents");
  const claudeProjectsDir = path.join(root, "claude-projects");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(claudeProjectsDir, { recursive: true });
  return {
    agentsDir,
    claudeProjectsDir,
    async project(name: string) {
      const p = path.join(claudeProjectsDir, name);
      await fs.mkdir(p, { recursive: true });
      return p;
    },
  };
}

describe("extractFieldsFromContent", () => {
  it("extracts topic_id from a stringified queue-operation content", () => {
    const embedded = JSON.stringify({
      content: 'Conversation info:\n```json\n{\n  "topic_id": "25123"\n}\n```\n',
    });
    const fields = __testing__.extractFieldsFromContent(embedded);
    expect(fields.topic_id).toEqual(new Set(["25123"]));
  });

  it("extracts sender_id for WhatsApp-style metadata", () => {
    const embedded = JSON.stringify({
      content: '```json\n{\n  "sender_id": "+15551234567"\n}\n```',
    });
    const fields = __testing__.extractFieldsFromContent(embedded);
    expect(fields.sender_id).toEqual(new Set(["+15551234567"]));
  });

  it("extracts slack-style decimal topic ids", () => {
    const embedded = JSON.stringify({
      content: '```json\n{\n  "topic_id": "1775591037.217389"\n}\n```',
    });
    const fields = __testing__.extractFieldsFromContent(embedded);
    expect(fields.topic_id).toEqual(new Set(["1775591037.217389"]));
  });

  it("collects all distinct values for a repeated field", () => {
    const content = '{"topic_id":"1"} some text {"topic_id":"1"} more {"topic_id":"2"}';
    const fields = __testing__.extractFieldsFromContent(content);
    expect([...fields.topic_id].toSorted((a, b) => a.localeCompare(b))).toEqual(["1", "2"]);
  });
});

describe("extractBindingIdentity", () => {
  it("reads telegram thread id from deliveryContext", () => {
    const identity = __testing__.extractBindingIdentity({
      deliveryContext: { channel: "telegram", to: "telegram:123", threadId: 42 },
    });
    expect(identity).toEqual({
      channel: "telegram",
      threadId: "42",
      to: "telegram:123",
      bareTo: "123",
      groupId: undefined,
    });
  });

  it("reads slack decimal thread id as string", () => {
    const identity = __testing__.extractBindingIdentity({
      deliveryContext: { channel: "slack", to: "user:U0A", threadId: "1775346922.923489" },
    });
    expect(identity?.threadId).toBe("1775346922.923489");
    expect(identity?.bareTo).toBe("U0A");
  });

  it("reads whatsapp direct identity with no threadId", () => {
    const identity = __testing__.extractBindingIdentity({
      deliveryContext: { channel: "whatsapp", to: "+15551234567" },
    });
    expect(identity?.channel).toBe("whatsapp");
    expect(identity?.threadId).toBeUndefined();
    expect(identity?.bareTo).toBe("+15551234567");
  });

  it("falls back to origin.provider when deliveryContext.channel is missing", () => {
    const identity = __testing__.extractBindingIdentity({
      deliveryContext: { threadId: "1775766214.117699" },
      origin: { provider: "slack", threadId: "1775766214.117699" },
    });
    expect(identity?.channel).toBe("slack");
    expect(identity?.threadId).toBe("1775766214.117699");
  });

  it("returns undefined for entries with no messaging context", () => {
    expect(__testing__.extractBindingIdentity({ sessionId: "abc" })).toBeUndefined();
  });
});

describe("runCliSessionHealthCheck (multi-channel)", () => {
  it("flags a stale Telegram binding by topic_id match", async () => {
    const fx = await createFixture("tg-stale");
    const projectDir = await fx.project("-Users-test--openclaw-workspace");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "aaaaaaaa-0000-0000-0000-000000000001",
      fields: [{ topic_id: "25123" }],
      padToBytes: 600_000,
    });
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "bbbbbbbb-0000-0000-0000-000000000001",
      fields: [{ topic_id: "25123" }],
      padToBytes: 30_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:25123": {
          deliveryContext: { channel: "telegram", to: "telegram:1", threadId: 25123 },
          cliSessionBindings: {
            "claude-cli": { sessionId: "bbbbbbbb-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.channel).toBe("telegram");
    expect(result.findings[0]?.bestSessionId.startsWith("aaaaaaaa")).toBe(true);
    expect(result.findings[0]?.conversationLabel).toBe("telegram:thread:25123");
  });

  it("flags a stale Slack binding by decimal topic_id", async () => {
    const fx = await createFixture("slack-stale");
    const projectDir = await fx.project("-Users-test--openclaw-workspace-hank");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "cccccccc-0000-0000-0000-000000000001",
      fields: [{ topic_id: "1775766214.117699" }],
      padToBytes: 200_000,
    });
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "dddddddd-0000-0000-0000-000000000001",
      fields: [{ topic_id: "1775766214.117699" }],
      padToBytes: 15_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "hank",
      store: {
        "agent:hank:slack:hank:direct:u:thread:1775766214.117699": {
          deliveryContext: {
            channel: "slack",
            to: "user:U0A",
            threadId: "1775766214.117699",
          },
          cliSessionBindings: {
            "claude-cli": { sessionId: "dddddddd-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.channel).toBe("slack");
    expect(result.findings[0]?.bestSessionId.startsWith("cccccccc")).toBe(true);
  });

  it("flags a stale WhatsApp direct binding by sender_id match on the bare phone number", async () => {
    const fx = await createFixture("wa-stale");
    const projectDir = await fx.project("-Users-test--openclaw-workspace-solayre");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "eeeeeeee-0000-0000-0000-000000000001",
      fields: [{ sender_id: "+15551234567" }],
      padToBytes: 2_000_000,
    });
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "ffffffff-0000-0000-0000-000000000001",
      fields: [{ sender_id: "+15551234567" }],
      padToBytes: 30_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "solayre",
      store: {
        "agent:solayre:whatsapp:solayre:direct:+15551234567": {
          deliveryContext: { channel: "whatsapp", to: "+15551234567" },
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
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.channel).toBe("whatsapp");
    expect(result.findings[0]?.conversationLabel).toBe("whatsapp:+15551234567");
    expect(result.findings[0]?.bestSessionId.startsWith("eeeeeeee")).toBe(true);
  });

  it("scopes candidates to the same project directory as the current binding", async () => {
    // Regression: if solayre-coworker binds a conversation with
    // +15551234567 and a different agent's project dir (solayre-leads)
    // also has a big session file mentioning +15551234567, the canary
    // must NOT propose the cross-agent file. Binding → current project →
    // scoped candidate set.
    const fx = await createFixture("scoping");
    const coworkerDir = await fx.project("-Users-test--openclaw-workspace-solayre-coworker");
    const leadsDir = await fx.project("-Users-test--openclaw-workspace-solayre-leads");
    // Huge file in the WRONG project (leads) for the same phone number.
    await writeClaudeSessionFile({
      projectDir: leadsDir,
      sessionId: "11111111-0000-0000-0000-000000000001",
      fields: [{ sender_id: "+15551234567" }],
      padToBytes: 5_000_000,
    });
    // Medium-sized current file in the CORRECT project (coworker).
    await writeClaudeSessionFile({
      projectDir: coworkerDir,
      sessionId: "22222222-0000-0000-0000-000000000001",
      fields: [{ sender_id: "+15551234567" }],
      padToBytes: 100_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "solayre-coworker",
      store: {
        "agent:solayre-coworker:whatsapp:solayre:direct:+15551234567": {
          deliveryContext: { channel: "whatsapp", to: "+15551234567" },
          cliSessionBindings: {
            "claude-cli": { sessionId: "22222222-0000-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    // Only the cross-project huge file matches the conversation, but
    // it's in a different project dir — scoping must exclude it.
    expect(result.findings).toEqual([]);
  });

  it("does not flag a topic binding with a small but uniquely-bound current file (best == current)", async () => {
    const fx = await createFixture("healthy");
    const projectDir = await fx.project("-Users-test--openclaw-workspace");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "33333333-0000-0000-0000-000000000001",
      fields: [{ topic_id: "900" }],
      padToBytes: 40_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:900": {
          deliveryContext: { channel: "telegram", to: "telegram:1", threadId: 900 },
          cliSessionBindings: {
            "claude-cli": { sessionId: "33333333-0000-0000-0000-000000000001" },
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

  it("flags a binding whose current sessionId has no file at all (currentFileExists=false)", async () => {
    const fx = await createFixture("missing");
    const projectDir = await fx.project("-Users-test--openclaw-workspace");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "44444444-0000-0000-0000-000000000001",
      fields: [{ topic_id: "800" }],
      padToBytes: 120_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:800": {
          deliveryContext: { channel: "telegram", to: "telegram:1", threadId: 800 },
          cliSessionBindings: {
            "claude-cli": { sessionId: "55555555-1111-0000-0000-000000000001" },
          },
        },
      },
    });

    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.currentFileExists).toBe(false);
    expect(result.findings[0]?.currentSizeBytes).toBe(0);
  });

  it("ignores bindings with no messaging deliveryContext", async () => {
    const fx = await createFixture("no-ctx");
    const projectDir = await fx.project("-Users-test--openclaw-workspace");
    await writeClaudeSessionFile({
      projectDir,
      sessionId: "66666666-0000-0000-0000-000000000001",
      fields: [{ topic_id: "700" }],
      padToBytes: 200_000,
    });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:script:cron-123": {
          cliSessionBindings: {
            "claude-cli": { sessionId: "77777777-0000-0000-0000-000000000001" },
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

  it("returns an empty result when the claude projects directory does not exist", async () => {
    const fx = await createFixture("no-claude");
    await fs.rm(fx.claudeProjectsDir, { recursive: true, force: true });
    await writeAgentStore({
      agentsDir: fx.agentsDir,
      agentName: "default",
      store: {
        "agent:default:telegram:default:direct:1:thread:1": {
          deliveryContext: { channel: "telegram", to: "telegram:1", threadId: 1 },
          cliSessionBindings: {
            "claude-cli": { sessionId: "88888888-0000-0000-0000-000000000001" },
          },
        },
      },
    });
    const result = await runCliSessionHealthCheck({
      agentsDir: fx.agentsDir,
      claudeProjectsDir: fx.claudeProjectsDir,
    });
    expect(result.findings).toEqual([]);
    expect(result.claudeSessionFilesScanned).toBe(0);
  });
});

describe("formatHealthCheckWarning", () => {
  it("returns undefined when there are no findings", () => {
    expect(
      formatHealthCheckWarning({
        agentsScanned: 1,
        bindingsScanned: 0,
        claudeSessionFilesScanned: 0,
        findings: [],
      }),
    ).toBeUndefined();
  });

  it("renders conversation labels for multiple channels and marks missing files", () => {
    const message = formatHealthCheckWarning({
      agentsScanned: 2,
      bindingsScanned: 2,
      claudeSessionFilesScanned: 4,
      findings: [
        {
          agent: "default",
          sessionKey: "agent:default:telegram:default:direct:1:thread:25123",
          channel: "telegram",
          threadId: "25123",
          conversationLabel: "telegram:thread:25123",
          currentSessionId: "bbbbbbbb-0000-0000-0000-000000000001",
          currentSizeBytes: 30000,
          currentFileExists: true,
          bestSessionId: "aaaaaaaa-0000-0000-0000-000000000001",
          bestSizeBytes: 600000,
          bestFilePath: "/tmp/ignored.jsonl",
          recoverableSiblings: 0,
        },
        {
          agent: "solayre",
          sessionKey: "agent:solayre:whatsapp:solayre:direct:+15551234567",
          channel: "whatsapp",
          conversationLabel: "whatsapp:+15551234567",
          currentSessionId: "ffffffff-0000-0000-0000-000000000001",
          currentSizeBytes: 0,
          currentFileExists: false,
          bestSessionId: "eeeeeeee-0000-0000-0000-000000000001",
          bestSizeBytes: 2_000_000,
          bestFilePath: "/tmp/ignored.jsonl",
          recoverableSiblings: 2,
        },
      ],
    });
    expect(message).toContain("telegram:thread:25123");
    expect(message).toContain("whatsapp:+15551234567");
    expect(message).toContain("(missing)");
  });
});
