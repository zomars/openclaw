#!/usr/bin/env node
/**
 * PROTOTYPE - throwaway.
 *
 * Question: does an execution-context router make remote machine work feel local
 * while keeping local-only control-plane tools separate?
 *
 * Default mode is fake transport so this can run without a real tailnet host:
 *   node scripts/prototypes/agentless-remote-router-prototype.mjs
 *
 * Optional real SSH smoke test:
 *   PROTOTYPE_REAL_SSH=1 PROTOTYPE_MACHINE_HOST=user@host \
 *     node scripts/prototypes/agentless-remote-router-prototype.mjs \
 *     "haz pwd en demo" "haz uname -a en demo"
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sessionId = `proto-${crypto.randomUUID().slice(0, 8)}`;
const state = {
  sessionId,
  activeTarget: { kind: "local" },
  connections: new Map(),
  log: [],
};

const registry = {
  demo: {
    alias: "demo",
    host: process.env.PROTOTYPE_MACHINE_HOST ?? "demo.tailnet.ts.net",
    user: process.env.USER ?? "zomars",
    defaultWorkdir: "/tmp",
    os: "linux",
  },
  "mac-mini-casa": {
    alias: "mac-mini-casa",
    host: "mac-mini-casa.tailnet.ts.net",
    user: "zomars",
    defaultWorkdir: "/Users/zomars",
    os: "darwin",
  },
};

const scenarios =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        "haz pwd en demo",
        "haz uname -a en demo",
        "lee memoria",
        "haz whoami local",
        "haz date en demo",
      ];

main();

function main() {
  printHeader();
  try {
    for (const prompt of scenarios) {
      runPrompt(prompt);
    }
    printState("final");
  } finally {
    cleanupRealSshConnections();
  }
}

function runPrompt(prompt) {
  const plan = resolvePrompt(prompt);
  if (plan.error) {
    printEvent(prompt, "resolver_error", plan);
    return;
  }

  if (plan.target) {
    state.activeTarget = plan.target;
  }

  const toolCalls = buildToolCalls(plan);
  for (const call of toolCalls) {
    const result = routeTool(call);
    state.log.push({ prompt, call, result });
    printEvent(prompt, call.name, result);
  }
  printState(prompt);
}

function resolvePrompt(prompt) {
  const lower = prompt.toLowerCase();
  const local = /\blocal\b/.test(lower);
  if (local) {
    return {
      target: { kind: "local" },
      command:
        stripIntent(prompt)
          .replace(/\blocal\b/i, "")
          .trim() || "pwd",
    };
  }

  const match = lower.match(/\ben\s+([a-z0-9._-]+)/i);
  if (match) {
    const alias = match[1];
    const machine = registry[alias];
    if (!machine) {
      return { error: `unknown machine alias: ${alias}`, knownMachines: Object.keys(registry) };
    }
    return {
      target: { kind: "remote", machine },
      command: stripIntent(prompt.replace(new RegExp(`\\ben\\s+${escapeRegExp(alias)}`, "i"), "")),
    };
  }

  return {
    target: state.activeTarget,
    command: stripIntent(prompt),
  };
}

function stripIntent(prompt) {
  return prompt
    .replace(/^haz\s+/i, "")
    .replace(/^ejecuta\s+/i, "")
    .trim();
}

function buildToolCalls(plan) {
  if (plan.command.toLowerCase().includes("memoria")) {
    return [{ name: "memory_get", args: { key: "demo" } }];
  }
  return [{ name: "exec_command", args: { cmd: plan.command || "pwd" } }];
}

function routeTool(call) {
  if (call.name === "memory_get") {
    return {
      target: "local:control-plane",
      localOnly: true,
      output: "memory_get remains local even while shell/files target a remote machine",
    };
  }

  if (call.name !== "exec_command") {
    return { target: formatTarget(state.activeTarget), error: `unknown tool: ${call.name}` };
  }

  if (state.activeTarget.kind === "local") {
    return runLocalExec(call.args.cmd);
  }

  return runRemoteExec(state.activeTarget.machine, call.args.cmd);
}

function runLocalExec(cmd) {
  const result = spawnSync("/bin/sh", ["-lc", cmd], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    target: "local",
    cmd,
    exitCode: result.status ?? 0,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function runRemoteExec(machine, cmd) {
  const connection = ensureConnection(machine);
  if (process.env.PROTOTYPE_REAL_SSH === "1") {
    return runRealSshExec(machine, connection, cmd);
  }
  return {
    target: `remote:${machine.alias}`,
    host: machine.host,
    cmd,
    controlPath: connection.controlPath,
    reusedConnection: connection.uses > 1,
    exitCode: 0,
    stdout: fakeRemoteOutput(machine, cmd),
    stderr: "",
  };
}

function runRealSshExec(machine, connection, cmd) {
  const userHost = machine.host.includes("@") ? machine.host : `${machine.user}@${machine.host}`;
  if (!connection.masterStarted) {
    fs.mkdirSync(path.dirname(connection.controlPath), { recursive: true });
    const master = spawnSync(
      "ssh",
      [
        "-MNf",
        ...sshOptions({ strictHostKeyChecking: process.env.PROTOTYPE_SSH_STRICT ?? "yes" }),
        "-o",
        "BatchMode=yes",
        "-o",
        `ControlMaster=yes`,
        "-o",
        `ControlPath=${connection.controlPath}`,
        "-o",
        "ControlPersist=900",
        "--",
        userHost,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    connection.masterStarted = master.status === 0;
    if (master.status !== 0) {
      return {
        target: `remote:${machine.alias}`,
        host: machine.host,
        cmd,
        controlPath: connection.controlPath,
        reusedConnection: false,
        exitCode: master.status ?? 1,
        stdout: trimOutput(master.stdout),
        stderr: trimOutput(master.stderr),
      };
    }
  }

  const result = spawnSync(
    "ssh",
    [
      ...sshOptions({ strictHostKeyChecking: process.env.PROTOTYPE_SSH_STRICT ?? "yes" }),
      "-o",
      "BatchMode=yes",
      "-o",
      `ControlPath=${connection.controlPath}`,
      "--",
      userHost,
      cmd,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  return {
    target: `remote:${machine.alias}`,
    host: machine.host,
    cmd,
    controlPath: connection.controlPath,
    reusedConnection: connection.uses > 1,
    exitCode: result.status ?? 0,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function sshOptions({ strictHostKeyChecking }) {
  const args = ["-o", `StrictHostKeyChecking=${strictHostKeyChecking}`];
  if (process.env.PROTOTYPE_SSH_KNOWN_HOSTS_FILE) {
    args.push("-o", `UserKnownHostsFile=${process.env.PROTOTYPE_SSH_KNOWN_HOSTS_FILE}`);
  }
  return args;
}

function cleanupRealSshConnections() {
  if (process.env.PROTOTYPE_REAL_SSH !== "1") {
    return;
  }
  for (const connection of state.connections.values()) {
    if (!connection.masterStarted) {
      continue;
    }
    const machine = registry[connection.machine];
    if (!machine) {
      continue;
    }
    const userHost = machine.host.includes("@") ? machine.host : `${machine.user}@${machine.host}`;
    spawnSync(
      "ssh",
      [
        ...sshOptions({ strictHostKeyChecking: process.env.PROTOTYPE_SSH_STRICT ?? "yes" }),
        "-o",
        `ControlPath=${connection.controlPath}`,
        "-O",
        "exit",
        "--",
        userHost,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
  }
}

function ensureConnection(machine) {
  const key = `${state.sessionId}:${machine.alias}:${machine.user}`;
  const existing = state.connections.get(key);
  if (existing) {
    existing.uses += 1;
    return existing;
  }
  const controlPath = path.join(
    resolveShortSocketRoot(),
    `${state.sessionId}-${machine.alias}.sock`,
  );
  const connection = {
    key,
    machine: machine.alias,
    user: machine.user,
    controlPath,
    uses: 1,
    masterStarted: false,
  };
  state.connections.set(key, connection);
  return connection;
}

function resolveShortSocketRoot() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join("/tmp", `oc-ssh-${uid}`);
}

function fakeRemoteOutput(machine, cmd) {
  if (cmd === "pwd") return machine.defaultWorkdir;
  if (cmd === "whoami") return machine.user;
  if (cmd === "uname -a") return `${machine.os} ${machine.alias} prototype-kernel`;
  if (cmd === "date") return new Date().toISOString();
  return `[fake remote:${machine.alias}] ${cmd}`;
}

function formatTarget(target) {
  return target.kind === "remote" ? `remote:${target.machine.alias}` : "local";
}

function printHeader() {
  console.log("PROTOTYPE: agentless remote execution context router");
  console.log(`session: ${state.sessionId}`);
  console.log(`transport: ${process.env.PROTOTYPE_REAL_SSH === "1" ? "real ssh" : "fake ssh"}`);
  console.log("");
}

function printEvent(prompt, tool, result) {
  console.log(`prompt: ${prompt}`);
  console.log(`tool: ${tool}`);
  console.log(JSON.stringify(result, null, 2));
  console.log("");
}

function printState(label) {
  console.log(`state after: ${label}`);
  console.log(
    JSON.stringify(
      {
        activeTarget: formatTarget(state.activeTarget),
        connections: [...state.connections.values()].map((connection) => ({
          machine: connection.machine,
          user: connection.user,
          uses: connection.uses,
          controlPath: connection.controlPath,
        })),
      },
      null,
      2,
    ),
  );
  console.log("");
}

function trimOutput(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 1_000);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
