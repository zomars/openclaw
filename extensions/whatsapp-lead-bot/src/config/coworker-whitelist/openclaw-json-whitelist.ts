/**
 * Reads coworker phones from an `openclaw.json` on disk. Cached after first load
 * so hot paths (every receipt) don't hit the filesystem repeatedly. Call
 * `invalidate()` to force a re-read.
 */

import { readFile } from "node:fs/promises";
import {
  type CoworkerWhitelistSource,
  type ExtractOptions,
  extractCoworkerPhones,
} from "../coworker-whitelist.js";

export interface OpenclawJsonWhitelistDeps extends ExtractOptions {
  configPath: string;
  /** Override the file reader for tests. */
  readFile?: (path: string) => Promise<string>;
}

export class OpenclawJsonWhitelistSource implements CoworkerWhitelistSource {
  private readonly read: (path: string) => Promise<string>;
  private cached: Set<string> | null = null;

  constructor(private readonly deps: OpenclawJsonWhitelistDeps) {
    this.read = deps.readFile ?? ((p) => readFile(p, "utf-8"));
  }

  async load(): Promise<Set<string>> {
    if (this.cached) {
      return this.cached;
    }
    const raw = await this.read(this.deps.configPath);
    const json = JSON.parse(raw) as unknown;
    const phones = extractCoworkerPhones(json, {
      agentId: this.deps.agentId,
      channel: this.deps.channel,
    });
    this.cached = new Set(phones);
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
