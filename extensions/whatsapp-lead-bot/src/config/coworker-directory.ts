/**
 * Coworker directory: enriches the coworker phone whitelist (single source of
 * truth for "is this a coworker?") with human-friendly names sourced from a
 * separate system (macOS Contacts, today). The whitelist remains authoritative
 * for identity — this directory only adds display metadata. When the name
 * resolver can't find a contact, `name` is `null` and consumers should fall
 * back to the phone number.
 */

import type { CoworkerWhitelistSource } from "./coworker-whitelist.js";

export interface CoworkerEntry {
  /** Canonical phone (digits-only, no leading "521" for MX). */
  phone: string;
  /** Display name from the source system, or null if not found. */
  name: string | null;
}

export interface CoworkerDirectory {
  /** Returns one entry per coworker in the whitelist. Order is unspecified. */
  list(): Promise<CoworkerEntry[]>;
  /** Drops any cached state so the next list() re-queries the sources. */
  invalidate(): void;
}

/**
 * Resolves canonical phone numbers to human-friendly names. Different
 * environments plug in different resolvers (macOS Contacts on a developer Mac,
 * a stubbed map in tests, eventually a remote service).
 */
export interface NameResolver {
  /**
   * Look up names for a batch of canonical phones. Returns a map keyed by
   * canonical phone; missing keys mean "not found". Batch API so the
   * implementation can do one round trip (one `osascript` call, one DB query,
   * etc.) instead of N.
   */
  resolveBatch(phones: readonly string[]): Promise<Map<string, string>>;
}

export interface CompositeCoworkerDirectoryDeps {
  whitelist: CoworkerWhitelistSource;
  resolver: NameResolver;
}

/**
 * Default directory implementation: combines the whitelist (identity) with a
 * pluggable name resolver (display). Caches resolved entries until invalidated.
 */
export class CompositeCoworkerDirectory implements CoworkerDirectory {
  private cached: CoworkerEntry[] | null = null;

  constructor(private readonly deps: CompositeCoworkerDirectoryDeps) {}

  async list(): Promise<CoworkerEntry[]> {
    if (this.cached) {
      return this.cached;
    }
    const phones = [...(await this.deps.whitelist.load())];
    const names = await this.deps.resolver.resolveBatch(phones);
    this.cached = phones.map((phone) => ({
      phone,
      name: names.get(phone) ?? null,
    }));
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Trivial resolver — returns no names. Use as a default when no contacts
 * backend is available; consumers fall back to phone numbers.
 */
export class NoopNameResolver implements NameResolver {
  async resolveBatch(_phones: readonly string[]): Promise<Map<string, string>> {
    return new Map();
  }
}
