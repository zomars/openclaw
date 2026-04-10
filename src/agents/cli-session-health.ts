import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Telegram topic file format emitted by the Pi runtime. We depend on the
 * filename convention `<sessionUUID>-topic-<topicId>.jsonl` to group
 * historical session files by topic without having to open any of them.
 */
const TOPIC_FILE_REGEX = /^([0-9a-f-]{36})-topic-(\d+)\.jsonl$/;

/**
 * Minimum size ratio below which the currently-bound session file is
 * considered suspiciously small relative to the best recoverable session
 * file for the same topic. At 10x, a binding pointing at a ~10 KB fresh
 * session when a 100 KB+ session exists for the same topic will trigger
 * a warning — strong signal that the amnesia class of bug fired.
 */
const SUSPICIOUS_RATIO = 10;

/**
 * Agents directory under `~/.openclaw`. Can be overridden for tests or
 * when running against a non-standard home. Only used to locate session
 * stores; never written to.
 */
export function resolveAgentsDir(home?: string): string {
  return path.join(home ?? os.homedir(), ".openclaw", "agents");
}

type SessionEntryStub = Record<string, unknown>;

type HealthFinding = {
  agent: string;
  sessionKey: string;
  topicId: number;
  currentSessionId?: string;
  currentSizeBytes: number;
  bestSessionId: string;
  bestSizeBytes: number;
  bestPath: string;
  recoverableSiblings: number;
};

type HealthCheckResult = {
  agentsScanned: number;
  bindingsScanned: number;
  findings: HealthFinding[];
};

function extractTopicIdFromKey(key: string): number | undefined {
  // Session keys end in `:<numericId>` for Telegram topic/thread entries.
  // Both old (`:thread:123`) and new (`:thread:<userId>:123`) shapes apply.
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

async function scanAgentSessionDir(params: {
  agentName: string;
  sessionsDir: string;
}): Promise<HealthFinding[]> {
  const { agentName, sessionsDir } = params;
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  // Map topicId → sorted list of (sessionId, path, size), biggest first.
  const topicFiles = new Map<number, { sessionId: string; filePath: string; size: number }[]>();
  for (const entry of entries) {
    const match = TOPIC_FILE_REGEX.exec(entry);
    const sessionId = match?.[1];
    const topicIdRaw = match?.[2];
    if (!sessionId || !topicIdRaw) {
      continue;
    }
    const topicId = Number.parseInt(topicIdRaw, 10);
    const filePath = path.join(sessionsDir, entry);
    let size = 0;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      continue;
    }
    const bucket = topicFiles.get(topicId) ?? [];
    bucket.push({ sessionId, filePath, size });
    topicFiles.set(topicId, bucket);
  }
  for (const bucket of topicFiles.values()) {
    bucket.sort((a, b) => b.size - a.size);
  }

  const storePath = path.join(sessionsDir, "sessions.json");
  let store: SessionEntryStub;
  try {
    store = JSON.parse(await fs.readFile(storePath, "utf-8")) as SessionEntryStub;
  } catch {
    return [];
  }

  const findings: HealthFinding[] = [];
  for (const [sessionKey, rawEntry] of Object.entries(store)) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      continue;
    }
    const topicId = extractTopicIdFromKey(sessionKey);
    if (topicId === undefined) {
      continue;
    }
    const candidates = topicFiles.get(topicId);
    const best = candidates?.[0];
    if (!candidates || !best) {
      continue;
    }

    const entry = rawEntry as { sessionFile?: unknown; sessionId?: unknown };
    const currentFile = typeof entry.sessionFile === "string" ? entry.sessionFile : undefined;
    let currentSize = 0;
    if (currentFile) {
      try {
        currentSize = (await fs.stat(currentFile)).size;
      } catch {
        currentSize = 0;
      }
    }
    const currentSessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;

    // Skip when the current binding is already pointing at the best file.
    if (best.sessionId === currentSessionId && best.size === currentSize) {
      continue;
    }
    // Skip when the ratio is within tolerance.
    if (currentSize > 0 && best.size < currentSize * SUSPICIOUS_RATIO) {
      continue;
    }

    findings.push({
      agent: agentName,
      sessionKey,
      topicId,
      currentSessionId,
      currentSizeBytes: currentSize,
      bestSessionId: best.sessionId,
      bestSizeBytes: best.size,
      bestPath: best.filePath,
      recoverableSiblings: candidates.length - 1,
    });
  }
  return findings;
}

/**
 * Walks every agent's session store and reports any binding whose current
 * `sessionFile` is dramatically smaller than the largest recoverable file
 * for the same topic. This is the canary for the "silent session wipe"
 * failure mode that the identity-gate subsystem used to cause: a binding
 * pointing at a ~600-byte fresh session while a ~500 KB session for the
 * same topic sits unused on disk.
 *
 * Read-only: never writes the store, never moves files. Callers should
 * invoke this at gateway boot (and optionally on a timer) and log the
 * findings so a human can decide whether to run the recovery tool.
 */
export async function runCliSessionHealthCheck(params?: {
  agentsDir?: string;
}): Promise<HealthCheckResult> {
  const agentsDir = params?.agentsDir ?? resolveAgentsDir();
  let agentNames: string[];
  try {
    agentNames = await fs.readdir(agentsDir);
  } catch {
    return { agentsScanned: 0, bindingsScanned: 0, findings: [] };
  }

  const findings: HealthFinding[] = [];
  let agentsScanned = 0;
  let bindingsScanned = 0;
  for (const agentName of agentNames) {
    const sessionsDir = path.join(agentsDir, agentName, "sessions");
    const agentFindings = await scanAgentSessionDir({ agentName, sessionsDir });
    agentsScanned += 1;
    bindingsScanned += agentFindings.length;
    findings.push(...agentFindings);
  }
  return { agentsScanned, bindingsScanned, findings };
}

export function formatHealthCheckWarning(result: HealthCheckResult): string | undefined {
  if (result.findings.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    `cli session health: ${result.findings.length} binding(s) may have lost history` +
      ` (current sessionFile is <1/${SUSPICIOUS_RATIO} the size of the best recoverable session).`,
  ];
  for (const finding of result.findings.slice(0, 10)) {
    const currentId = finding.currentSessionId?.slice(0, 8) ?? "(none)";
    lines.push(
      `  [${finding.agent}] topic=${finding.topicId}` +
        ` current=${currentId}/${finding.currentSizeBytes}B` +
        ` best=${finding.bestSessionId.slice(0, 8)}/${finding.bestSizeBytes}B`,
    );
  }
  if (result.findings.length > 10) {
    lines.push(`  ... ${result.findings.length - 10} more`);
  }
  return lines.join("\n");
}
