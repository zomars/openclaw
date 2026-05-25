#!/usr/bin/env node
/**
 * One-shot migration for the strict-opt-in plugin scoping rollout
 * (`plugins.entries.<id>.allowAgents`).
 *
 * Background:
 *   The gateway now treats an absent or empty `allowAgents` as "this plugin
 *   is inert for every agent". Plugins that ship hooks would silently stop
 *   firing for existing installs unless their entry explicitly lists which
 *   agents may see them. This script writes a sensible default — typically
 *   the wildcard `["*"]` — so existing installs keep working after the
 *   upgrade. Operators can later tighten the scope per plugin without
 *   touching the schema.
 *
 * Usage:
 *   node scripts/migrate-allow-agents.mjs                 # rewrites ~/.openclaw/openclaw.json
 *   node scripts/migrate-allow-agents.mjs --dry-run       # prints the merged JSON; no write
 *   node scripts/migrate-allow-agents.mjs --config <path> # target a different openclaw.json
 *   node scripts/migrate-allow-agents.mjs --leads-only    # only set allowAgents for solayre-leads-shaped entries
 *
 * Safety:
 *   - Reads first; writes only the merged JSON.
 *   - Preserves every existing field (allow/deny/load/slots/entries/etc.).
 *   - Defers to whatever `allowAgents` the operator already set (never overwrites).
 *   - Mirrors the openclaw-gateway rule: never overwrite the file blindly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WILDCARD = ["*"];

// Plugins we know should default to a narrow agent set instead of wildcard
// (because they ship agent-scoped hooks today and the user has been working
// on the lead-bot split).
const PLUGIN_DEFAULTS = {
  "whatsapp-lead-bot": ["solayre-leads"],
  "solayre-quotes-coworker": ["solayre-coworker"],
  "solayre-quotes-leads": ["solayre-leads"],
};

function parseArgs(argv) {
  const args = { dryRun: false, leadsOnly: false, configPath: null };
  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--leads-only") {
      args.leadsOnly = true;
    } else if (value === "--config") {
      args.configPath = argv[++i];
    } else if (value === "--help" || value === "-h") {
      console.log(`Usage: migrate-allow-agents.mjs [--dry-run] [--leads-only] [--config <path>]`);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${value}`);
      process.exit(2);
    }
  }
  return args;
}

function resolveConfigPath(override) {
  if (override) {
    return path.resolve(override);
  }
  const envPath = process.env.OPENCLAW_CONFIG_PATH;
  if (envPath) {
    return path.resolve(envPath);
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function defaultAllowAgentsForPlugin(pluginId, leadsOnly) {
  const explicit = PLUGIN_DEFAULTS[pluginId];
  if (explicit) {
    return explicit;
  }
  if (leadsOnly) {
    // In leads-only mode, only the known-narrow plugins are touched.
    return null;
  }
  return DEFAULT_WILDCARD;
}

function migrate(config, options) {
  if (!config || typeof config !== "object") {
    throw new Error("openclaw.json: top-level must be an object");
  }
  const plugins = (config.plugins ??= {});
  const entries = (plugins.entries ??= {});
  const summary = { updated: [], skipped: [], untouched: [] };

  for (const [pluginId, rawEntry] of Object.entries(entries)) {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : (entries[pluginId] = {});
    if (Array.isArray(entry.allowAgents)) {
      summary.untouched.push({ pluginId, reason: "allowAgents already set" });
      continue;
    }
    const defaults = defaultAllowAgentsForPlugin(pluginId, options.leadsOnly);
    if (!defaults) {
      summary.skipped.push({ pluginId, reason: "leads-only mode; not in narrow defaults" });
      continue;
    }
    entry.allowAgents = defaults;
    summary.updated.push({ pluginId, allowAgents: defaults });
  }

  return summary;
}

function writeJson(filePath, value) {
  const tmpPath = `${filePath}.migrate-allow-agents.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmpPath, text, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function main(argv) {
  const args = parseArgs(argv);
  const configPath = resolveConfigPath(args.configPath);
  if (!fs.existsSync(configPath)) {
    console.error(`openclaw.json not found at ${configPath}`);
    process.exit(1);
  }

  const before = readJson(configPath);
  const summary = migrate(before, { leadsOnly: args.leadsOnly });
  const updated = summary.updated.length;
  const untouched = summary.untouched.length;
  const skipped = summary.skipped.length;

  console.log(`[migrate-allow-agents] ${configPath}`);
  console.log(`  updated:   ${updated}`);
  console.log(`  untouched: ${untouched}`);
  console.log(`  skipped:   ${skipped}`);
  for (const item of summary.updated) {
    console.log(`    + ${item.pluginId}.allowAgents = ${JSON.stringify(item.allowAgents)}`);
  }
  for (const item of summary.untouched) {
    console.log(`    = ${item.pluginId} (${item.reason})`);
  }
  for (const item of summary.skipped) {
    console.log(`    - ${item.pluginId} (${item.reason})`);
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: not writing. Resulting JSON:\n`);
    console.log(JSON.stringify(before, null, 2));
    return;
  }

  if (updated === 0) {
    console.log(`No changes needed.`);
    return;
  }
  writeJson(configPath, before);
  console.log(`\nWrote ${configPath}`);
  console.log(`Next: openclaw doctor --fix && openclaw gateway reload`);
}

main(process.argv);
