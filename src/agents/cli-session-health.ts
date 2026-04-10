import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Matches messaging conversation identifier fields inside a Claude CLI
 * session file. The runtime embeds the inbound message metadata as a JSON
 * object inside a markdown code block inside a `content` string field on
 * each `queue-operation` line — so the interesting fields end up
 * triple-escaped by the time they hit disk. This regex tolerates both the
 * raw (`"topic_id": "25123"`) and the inner-string-escaped
 * (`\"topic_id\": \"25123\"`) forms. The captured value may be numeric
 * (Telegram thread id), decimal (Slack thread timestamp), a phone number,
 * or any other channel-specific identifier.
 */
const FIELD_VALUE_REGEX =
  /\\?"(?<field>topic_id|sender_id|chat_id|group_id|thread_label)\\?"\s*:\s*\\?"(?<value>[^"\\]+)\\?"/g;

const HEAD_READ_BYTES = 500_000;

/**
 * Minimum size ratio below which the currently-bound Claude CLI session
 * file is considered suspiciously small relative to the best recoverable
 * session file for the same conversation. At 10×, a binding pointing at a
 * ~10 KB fresh session when a ~100 KB+ session exists for the same
 * conversation triggers a warning.
 */
const SUSPICIOUS_RATIO = 10;

export function resolveAgentsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".openclaw", "agents");
}

export function resolveClaudeProjectsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".claude", "projects");
}

type SessionFileIndexEntry = {
  sessionId: string;
  project: string;
  filePath: string;
  size: number;
  fields: Record<string, Set<string>>;
};

type HealthFinding = {
  agent: string;
  sessionKey: string;
  channel: string;
  threadId?: string;
  conversationLabel: string;
  currentSessionId?: string;
  currentSizeBytes: number;
  currentFileExists: boolean;
  bestSessionId: string;
  bestSizeBytes: number;
  bestFilePath: string;
  recoverableSiblings: number;
};

type HealthCheckResult = {
  agentsScanned: number;
  bindingsScanned: number;
  claudeSessionFilesScanned: number;
  findings: HealthFinding[];
};

async function readHeadChunk(filePath: string, bytes: number): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.slice(0, bytesRead).toString("utf-8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function extractFieldsFromContent(content: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const match of content.matchAll(FIELD_VALUE_REGEX)) {
    const field = match.groups?.field;
    const value = match.groups?.value;
    if (!field || !value) {
      continue;
    }
    const bucket = out[field] ?? new Set<string>();
    bucket.add(value);
    out[field] = bucket;
  }
  return out;
}

async function buildClaudeSessionIndex(params: {
  claudeProjectsDir: string;
}): Promise<{
  byId: Map<string, SessionFileIndexEntry>;
  byProject: Map<string, SessionFileIndexEntry[]>;
}> {
  const byId = new Map<string, SessionFileIndexEntry>();
  const byProject = new Map<string, SessionFileIndexEntry[]>();
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(params.claudeProjectsDir);
  } catch {
    return { byId, byProject };
  }
  for (const projectDirName of projectDirs) {
    const projectDir = path.join(params.claudeProjectsDir, projectDirName);
    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      continue;
    }
    const projectEntries: SessionFileIndexEntry[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(projectDir, entry);
      let size = 0;
      try {
        size = (await fs.stat(filePath)).size;
      } catch {
        continue;
      }
      const head = await readHeadChunk(filePath, HEAD_READ_BYTES);
      if (head === undefined) {
        continue;
      }
      const fields = extractFieldsFromContent(head);
      const sessionId = entry.slice(0, -".jsonl".length);
      const indexEntry: SessionFileIndexEntry = {
        sessionId,
        project: projectDirName,
        filePath,
        size,
        fields,
      };
      byId.set(sessionId, indexEntry);
      projectEntries.push(indexEntry);
    }
    byProject.set(projectDirName, projectEntries);
  }
  return { byId, byProject };
}

type BindingIdentity = {
  channel: string;
  threadId?: string;
  to?: string;
  bareTo?: string;
  groupId?: string;
};

function stripChannelPrefix(value: string): string {
  for (const prefix of ["user:", "telegram:", "whatsapp:", "slack:", "discord:"]) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

function extractBindingIdentity(rawEntry: unknown): BindingIdentity | undefined {
  if (typeof rawEntry !== "object" || rawEntry === null) {
    return undefined;
  }
  const deliveryContext = (rawEntry as { deliveryContext?: unknown }).deliveryContext;
  const origin = (rawEntry as { origin?: unknown }).origin;
  const dc =
    typeof deliveryContext === "object" && deliveryContext !== null
      ? (deliveryContext as Record<string, unknown>)
      : {};
  const og =
    typeof origin === "object" && origin !== null ? (origin as Record<string, unknown>) : {};
  const channelRaw =
    (typeof dc.channel === "string" && dc.channel) ||
    (typeof og.provider === "string" && og.provider);
  if (!channelRaw) {
    return undefined;
  }
  const channel = String(channelRaw);
  const threadIdRaw = dc.threadId ?? og.threadId;
  let threadId: string | undefined;
  if (typeof threadIdRaw === "string") {
    threadId = threadIdRaw;
  } else if (typeof threadIdRaw === "number" && Number.isFinite(threadIdRaw)) {
    threadId = String(threadIdRaw);
  }
  const toRaw = dc.to ?? og.to;
  const to = typeof toRaw === "string" ? toRaw : undefined;
  const bareTo = to ? stripChannelPrefix(to) : undefined;
  const groupIdRaw = dc.groupId ?? og.groupId;
  const groupId = typeof groupIdRaw === "string" ? groupIdRaw : undefined;
  return { channel, threadId, to, bareTo, groupId };
}

function fileMatchesBinding(entry: SessionFileIndexEntry, identity: BindingIdentity): boolean {
  const fields = entry.fields;
  const { channel, threadId, bareTo, groupId } = identity;
  if (["telegram", "slack", "discord"].includes(channel) && threadId) {
    return fields.topic_id?.has(threadId) ?? false;
  }
  if (channel === "whatsapp") {
    const targets = new Set<string>();
    if (bareTo) {
      targets.add(bareTo);
    }
    if (groupId) {
      targets.add(groupId);
    }
    if (targets.size === 0) {
      return false;
    }
    for (const fieldName of ["sender_id", "chat_id", "group_id"] as const) {
      const values = fields[fieldName];
      if (!values) {
        continue;
      }
      for (const target of targets) {
        if (values.has(target)) {
          return true;
        }
      }
    }
  }
  return false;
}

function describeConversation(identity: BindingIdentity): string {
  if (identity.threadId) {
    return `${identity.channel}:thread:${identity.threadId}`;
  }
  if (identity.groupId) {
    return `${identity.channel}:group:${identity.groupId}`;
  }
  if (identity.bareTo) {
    return `${identity.channel}:${identity.bareTo}`;
  }
  return identity.channel;
}

type AgentStore = Record<string, unknown>;

function getClaudeSessionId(rawEntry: unknown): string | undefined {
  if (typeof rawEntry !== "object" || rawEntry === null) {
    return undefined;
  }
  const bindings = (rawEntry as { cliSessionBindings?: unknown }).cliSessionBindings;
  if (typeof bindings !== "object" || bindings === null) {
    return undefined;
  }
  const claude = (bindings as Record<string, unknown>)["claude-cli"];
  if (typeof claude !== "object" || claude === null) {
    return undefined;
  }
  const sessionId = (claude as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

async function scanAgentStore(params: {
  agentName: string;
  storePath: string;
  index: {
    byId: Map<string, SessionFileIndexEntry>;
    byProject: Map<string, SessionFileIndexEntry[]>;
  };
}): Promise<{ findings: HealthFinding[]; bindingsScanned: number }> {
  let store: AgentStore;
  try {
    store = JSON.parse(await fs.readFile(params.storePath, "utf-8")) as AgentStore;
  } catch {
    return { findings: [], bindingsScanned: 0 };
  }

  const findings: HealthFinding[] = [];
  let bindingsScanned = 0;
  for (const [sessionKey, rawEntry] of Object.entries(store)) {
    const currentSessionId = getClaudeSessionId(rawEntry);
    if (!currentSessionId) {
      continue;
    }
    const identity = extractBindingIdentity(rawEntry);
    if (!identity) {
      continue;
    }
    bindingsScanned += 1;

    const currentEntry = params.index.byId.get(currentSessionId);
    // Scope candidates to the project of the current session file when we
    // can see it. If the current file is missing, fall back to the whole
    // index — the binding is already broken, so even a cross-project
    // recovery is an improvement over nothing.
    const scopedCandidates: SessionFileIndexEntry[] = currentEntry
      ? (params.index.byProject.get(currentEntry.project) ?? [])
      : [...params.index.byId.values()];

    const matching = scopedCandidates.filter((entry) => fileMatchesBinding(entry, identity));
    if (matching.length === 0) {
      continue;
    }
    matching.sort((a, b) => b.size - a.size);
    const best = matching[0];
    if (!best) {
      continue;
    }
    if (best.sessionId === currentSessionId) {
      continue;
    }
    const currentSizeBytes = currentEntry?.size ?? 0;
    const currentFileExists = Boolean(currentEntry);
    if (currentFileExists && best.size < currentSizeBytes * SUSPICIOUS_RATIO) {
      continue;
    }

    findings.push({
      agent: params.agentName,
      sessionKey,
      channel: identity.channel,
      threadId: identity.threadId,
      conversationLabel: describeConversation(identity),
      currentSessionId,
      currentSizeBytes,
      currentFileExists,
      bestSessionId: best.sessionId,
      bestSizeBytes: best.size,
      bestFilePath: best.filePath,
      recoverableSiblings: matching.length - 1,
    });
  }
  return { findings, bindingsScanned };
}

/**
 * Walks every agent's session store and reports any Claude CLI binding
 * whose currently-bound session file is dramatically smaller than the
 * largest recoverable session file for the same messaging conversation.
 *
 * Supports every messaging channel that embeds its conversation identity
 * into the session file metadata as `topic_id` (threaded: Telegram,
 * Slack, Discord), `sender_id` (direct: WhatsApp), or `group_id` /
 * `chat_id` (group: WhatsApp groups). Extending to additional channels
 * means teaching `fileMatchesBinding` how to compare the binding's
 * `deliveryContext` against additional field names — no changes to the
 * call sites or file-scanning path.
 *
 * Scoping rule: candidate session files are restricted to the same
 * Claude CLI project directory as the binding's currently-bound file.
 * Different OpenClaw agents run with different cwds and therefore live
 * in different project directories, so scope-by-project prevents a
 * +15551234567 binding on solayre-coworker from being falsely rebound
 * to a +15551234567 session owned by solayre-leads.
 *
 * Read-only: never writes any session store, never modifies any session
 * file. Callers invoke this at gateway boot and log findings so a human
 * can decide whether to run the recovery flow.
 */
export async function runCliSessionHealthCheck(params?: {
  agentsDir?: string;
  claudeProjectsDir?: string;
}): Promise<HealthCheckResult> {
  const agentsDir = params?.agentsDir ?? resolveAgentsDir();
  const claudeProjectsDir = params?.claudeProjectsDir ?? resolveClaudeProjectsDir();

  const index = await buildClaudeSessionIndex({ claudeProjectsDir });

  let agentNames: string[];
  try {
    agentNames = await fs.readdir(agentsDir);
  } catch {
    return {
      agentsScanned: 0,
      bindingsScanned: 0,
      claudeSessionFilesScanned: index.byId.size,
      findings: [],
    };
  }

  const findings: HealthFinding[] = [];
  let agentsScanned = 0;
  let bindingsScanned = 0;
  for (const agentName of agentNames) {
    const storePath = path.join(agentsDir, agentName, "sessions", "sessions.json");
    const result = await scanAgentStore({ agentName, storePath, index });
    if (result.bindingsScanned > 0) {
      agentsScanned += 1;
    }
    bindingsScanned += result.bindingsScanned;
    findings.push(...result.findings);
  }

  return {
    agentsScanned,
    bindingsScanned,
    claudeSessionFilesScanned: index.byId.size,
    findings,
  };
}

export function formatHealthCheckWarning(result: HealthCheckResult): string | undefined {
  if (result.findings.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    `cli session health: ${result.findings.length} binding(s) may have lost Claude CLI history` +
      ` (current resume target is <1/${SUSPICIOUS_RATIO} the size of the best recoverable session for the same conversation).`,
  ];
  for (const finding of result.findings.slice(0, 10)) {
    const currentId = finding.currentSessionId?.slice(0, 8) ?? "(none)";
    const missingTag = finding.currentFileExists ? "" : " (missing)";
    lines.push(
      `  [${finding.agent}] ${finding.conversationLabel}` +
        ` current=${currentId}/${finding.currentSizeBytes}B${missingTag}` +
        ` best=${finding.bestSessionId.slice(0, 8)}/${finding.bestSizeBytes}B`,
    );
  }
  if (result.findings.length > 10) {
    lines.push(`  ... ${result.findings.length - 10} more`);
  }
  return lines.join("\n");
}

// Exported only for tests that want to verify the low-level helpers
// directly without standing up a full Claude project dir fixture.
export const __testing__ = {
  extractFieldsFromContent,
  extractBindingIdentity,
  stripChannelPrefix,
  describeConversation,
  fileMatchesBinding,
};
