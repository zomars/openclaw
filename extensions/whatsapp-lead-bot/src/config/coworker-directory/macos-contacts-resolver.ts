/**
 * Resolves coworker phones to names by querying macOS Contacts.app via JXA.
 *
 * Strategy: one `osascript` invocation iterates every Contact once, normalizes
 * each phone, and matches against the requested set. O(contacts) per call
 * instead of O(contacts × phones) — the cost is one process spawn (~200-400ms)
 * regardless of whitelist size, which is fine for boot-time cache fill.
 *
 * Falls back to an empty map if the script fails (Contacts blocked, permission
 * denied, non-macOS, etc.) so the plugin keeps booting on environments where
 * Contacts isn't available.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePhone } from "../../utils/phone.js";
import type { NameResolver } from "../coworker-directory.js";

const execFileAsync = promisify(execFile);

export interface MacOSContactsResolverOptions {
  /** Override the shell-out for tests. Receives the JXA script, returns stdout. */
  runJxa?: (script: string) => Promise<string>;
  /** Timeout for the osascript call in ms. Default 5000. */
  timeoutMs?: number;
}

export class MacOSContactsResolver implements NameResolver {
  private readonly run: (script: string) => Promise<string>;

  constructor(options: MacOSContactsResolverOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 5000;
    this.run =
      options.runJxa ??
      (async (script) => {
        const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        return stdout;
      });
  }

  async resolveBatch(phones: readonly string[]): Promise<Map<string, string>> {
    const targets = [...new Set(phones.map(normalizePhone))].filter((p) => p.length > 0);
    if (targets.length === 0) {
      return new Map();
    }

    const script = buildJxaScript(targets);

    try {
      const raw = await this.run(script);
      const parsed = JSON.parse(raw) as Record<string, string>;
      const out = new Map<string, string>();
      for (const [phone, name] of Object.entries(parsed)) {
        if (typeof name === "string" && name.trim().length > 0) {
          out.set(phone, name.trim());
        }
      }
      return out;
    } catch (err) {
      console.warn(
        `[whatsapp-lead-bot] MacOSContactsResolver: ${err instanceof Error ? err.message : String(err)}; falling back to phones only`,
      );
      return new Map();
    }
  }
}

function buildJxaScript(targets: readonly string[]): string {
  // Embed the targets directly. They're canonical digits-only strings, no
  // need for further escaping, and JSON.stringify gives a safe JS literal.
  return `
    const Contacts = Application('Contacts');
    const targets = new Set(${JSON.stringify(targets)});
    const normalize = (p) => {
      let d = String(p || '').replace(/[^0-9]/g, '');
      if (d.length === 13 && d.indexOf('521') === 0) d = '52' + d.slice(3);
      return d;
    };
    const out = {};
    const people = Contacts.people();
    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      const phoneObjs = person.phones();
      for (let j = 0; j < phoneObjs.length; j++) {
        const canonical = normalize(phoneObjs[j].value());
        if (targets.has(canonical) && !(canonical in out)) {
          const fn = person.firstName() || '';
          const ln = person.lastName() || '';
          const name = (fn + (ln ? ' ' + ln : '')).trim();
          if (name.length > 0) out[canonical] = name;
        }
      }
    }
    JSON.stringify(out);
  `.trim();
}
