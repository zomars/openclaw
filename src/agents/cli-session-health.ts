import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Extracts a messaging `topic_id` from an arbitrary string. Claude CLI's own
 * session files (`~/.claude/projects/<project>/<uuid>.jsonl`) store the
 * inbound message context as a JSON blob embedded inside a message
 * `content` string. The context object carries `topic_id` (or equivalent
 * messaging-thread identifier). We scan up to a small head of each file
 * for this pattern — the first enqueue message usually contains it — so the
 * canary is O(bytes-read-per-file) rather than O(full-file).
 *
 * The regex matches both unescaped (`"topic_id": "123"`) and JSON-string
 * embedded (`\"topic_id\": \"123\"`) forms because the `content` field is
 * a JSON-encoded string-inside-a-string.
 */
const TOPIC_ID_REGEX = /\\?"topic_id\\?"\s*:\s*\\?"?(\d+)\\?"?/g;

/**
 * Number of bytes to read from the head of each Claude CLI session file
 * when extracting topic IDs. The first `queue-operation` message carrying
 * the topic metadata is typically within the first few KB, so 500 KB is
 * a comfortable upper bound that still keeps the scan fast.
 */
const HEAD_READ_BYTES = 500_000;

/**
 * Minimum size ratio below which the currently-bound Claude CLI session
 * file is considered suspiciously small relative to the best recoverable
 * session file for the same topic. At 10x, a binding pointing at a
 * ~10 KB fresh session when a ~100 KB+ session exists for the same topic
 * will trigger a warning.
 */
const SUSPICIOUS_RATIO = 10;

export function resolveAgentsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".openclaw", "agents");
}

export function resolveClaudeProjectsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".claude", "projects");
}

type TopicSessionCandidate = {
  sessionId: string;
  filePath: string;
  size: number;
};

type HealthFinding = {
  agent: string;
  sessionKey: string;
  topicId: number;
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
  topicsWithHistory: number;
  findings: HealthFinding[];
};

function extractTopicIdFromKey(key: string): number | undefined {
  // Session keys end in `:<numericId>` for messaging topic/thread entries
  // (both old `:thread:123` and new `:thread:<userId>:123` shapes apply).
  const lastColon = key.lastIndexOf(":");
  if (lastColon === -1) {
    return undefined;
  }
  const tail = key.slice(lastColon + 1);
  if (!/^\d+$/.test(tail)) {
    return undefined;
  }
  return Number.parseInt(tail, 10);
}

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

function extractTopicIdsFromContent(content: string): Set<number> {
  const ids = new Set<number>();
  for (const match of content.matchAll(TOPIC_ID_REGEX)) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      ids.add(parsed);
    }
  }
  return ids;
}

/**
 * Walks every Claude CLI project directory and groups every session file
 * by the `topic_id` found in its content. Returns a map from topic id to
 * every candidate session, sorted by size descending (biggest = most
 * conversation content). Skips directories we can't read without raising.
 */
async function buildClaudeSessionTopicIndex(params: {
  claudeProjectsDir: string;
}): Promise<{ index: Map<number, TopicSessionCandidate[]>; filesScanned: number }> {
  const index = new Map<number, TopicSessionCandidate[]>();
  let filesScanned = 0;

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(params.claudeProjectsDir);
  } catch {
    return { index, filesScanned };
  }

  for (const projectDirName of projectDirs) {
    const projectDir = path.join(params.claudeProjectsDir, projectDirName);
    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      continue;
    }
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
      filesScanned += 1;
      const topicIds = extractTopicIdsFromContent(head);
      if (topicIds.size === 0) {
        continue;
      }
      const sessionId = entry.slice(0, -".jsonl".length);
      const candidate: TopicSessionCandidate = { sessionId, filePath, size };
      for (const topicId of topicIds) {
        const bucket = index.get(topicId) ?? [];
        bucket.push(candidate);
        index.set(topicId, bucket);
      }
    }
  }

  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.size - a.size);
  }
  return { index, filesScanned };
}

type AgentStore = Record<string, unknown>;

type CliBindingShape = {
  sessionId?: unknown;
};

function getClaudeBinding(entry: unknown): CliBindingShape | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const bindings = (entry as { cliSessionBindings?: unknown }).cliSessionBindings;
  if (typeof bindings !== "object" || bindings === null) {
    return undefined;
  }
  const claude = (bindings as Record<string, unknown>)["claude-cli"];
  if (typeof claude !== "object" || claude === null) {
    return undefined;
  }
  return claude as CliBindingShape;
}

async function scanAgentStore(params: {
  agentName: string;
  storePath: string;
  topicIndex: Map<number, TopicSessionCandidate[]>;
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
    const topicId = extractTopicIdFromKey(sessionKey);
    if (topicId === undefined) {
      continue;
    }
    const claudeBinding = getClaudeBinding(rawEntry);
    if (!claudeBinding) {
      continue;
    }
    bindingsScanned += 1;

    const candidates = params.topicIndex.get(topicId);
    if (!candidates || candidates.length === 0) {
      continue;
    }
    const best = candidates[0];
    if (!best) {
      continue;
    }

    const currentSessionId =
      typeof claudeBinding.sessionId === "string" && claudeBinding.sessionId.length > 0
        ? claudeBinding.sessionId
        : undefined;

    const currentCandidate = currentSessionId
      ? candidates.find((c) => c.sessionId === currentSessionId)
      : undefined;
    const currentSizeBytes = currentCandidate?.size ?? 0;
    const currentFileExists = Boolean(currentCandidate);

    if (currentCandidate && currentCandidate.sessionId === best.sessionId) {
      continue;
    }
    // If the current binding points at a file we can see, require a big
    // size delta before flagging — otherwise active-but-small topics (a
    // brand-new 3-message thread) would generate noise.
    if (currentFileExists && best.size < currentSizeBytes * SUSPICIOUS_RATIO) {
      continue;
    }

    findings.push({
      agent: params.agentName,
      sessionKey,
      topicId,
      currentSessionId,
      currentSizeBytes,
      currentFileExists,
      bestSessionId: best.sessionId,
      bestSizeBytes: best.size,
      bestFilePath: best.filePath,
      recoverableSiblings: candidates.length - 1,
    });
  }
  return { findings, bindingsScanned };
}

/**
 * Walks every agent's session store and reports any binding whose
 * currently-bound **Claude CLI** session file (tracked under
 * `cliSessionBindings["claude-cli"].sessionId` and physically stored at
 * `~/.claude/projects/<project>/<uuid>.jsonl`) is dramatically smaller
 * than the largest recoverable session file for the same messaging topic.
 *
 * This is the canary for the "silent Claude CLI session swap" failure
 * mode where a stored sessionId gets replaced — by a hash-gate
 * invalidation, a crash mid-turn, or any other path — and the previous
 * conversation is orphaned in `~/.claude/projects/`. Bindings that are
 * active and healthy (current size reasonably close to the best
 * recoverable size) do not fire the canary.
 *
 * Read-only: never writes any session store, never modifies any session
 * file. Callers should invoke this at gateway boot and log findings so a
 * human can decide whether to run the recovery flow.
 */
export async function runCliSessionHealthCheck(params?: {
  agentsDir?: string;
  claudeProjectsDir?: string;
}): Promise<HealthCheckResult> {
  const agentsDir = params?.agentsDir ?? resolveAgentsDir();
  const claudeProjectsDir = params?.claudeProjectsDir ?? resolveClaudeProjectsDir();

  const { index: topicIndex, filesScanned } = await buildClaudeSessionTopicIndex({
    claudeProjectsDir,
  });

  let agentNames: string[];
  try {
    agentNames = await fs.readdir(agentsDir);
  } catch {
    return {
      agentsScanned: 0,
      bindingsScanned: 0,
      claudeSessionFilesScanned: filesScanned,
      topicsWithHistory: topicIndex.size,
      findings: [],
    };
  }

  const findings: HealthFinding[] = [];
  let agentsScanned = 0;
  let bindingsScanned = 0;
  for (const agentName of agentNames) {
    const storePath = path.join(agentsDir, agentName, "sessions", "sessions.json");
    const result = await scanAgentStore({ agentName, storePath, topicIndex });
    if (result.bindingsScanned > 0) {
      agentsScanned += 1;
    }
    bindingsScanned += result.bindingsScanned;
    findings.push(...result.findings);
  }

  return {
    agentsScanned,
    bindingsScanned,
    claudeSessionFilesScanned: filesScanned,
    topicsWithHistory: topicIndex.size,
    findings,
  };
}

export function formatHealthCheckWarning(result: HealthCheckResult): string | undefined {
  if (result.findings.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    `cli session health: ${result.findings.length} binding(s) may have lost Claude CLI history` +
      ` (current resume target is <1/${SUSPICIOUS_RATIO} the size of the best recoverable session for the same topic).`,
  ];
  for (const finding of result.findings.slice(0, 10)) {
    const currentId = finding.currentSessionId?.slice(0, 8) ?? "(none)";
    const missingTag = finding.currentFileExists ? "" : " (missing)";
    lines.push(
      `  [${finding.agent}] topic=${finding.topicId}` +
        ` current=${currentId}/${finding.currentSizeBytes}B${missingTag}` +
        ` best=${finding.bestSessionId.slice(0, 8)}/${finding.bestSizeBytes}B`,
    );
  }
  if (result.findings.length > 10) {
    lines.push(`  ... ${result.findings.length - 10} more`);
  }
  return lines.join("\n");
}

// Exported only for tests that want to verify the topic-id extractor
// directly without standing up a full Claude project dir.
export const __testing__ = {
  extractTopicIdsFromContent,
  extractTopicIdFromKey,
};
