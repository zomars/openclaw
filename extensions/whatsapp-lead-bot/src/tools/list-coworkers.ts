/**
 * Tool: list_coworkers
 *
 * Returns the directory of coworkers (phone + display name) so the agent can
 * answer "who is +52…?" or resolve "Aleyda → which phone?" without keeping a
 * roster in its prompt. Phones come from `openclaw.json` → `bindings[]`
 * (single source of truth); names come from macOS Contacts when available.
 */

import type { CoworkerDirectory, CoworkerEntry } from "../config/coworker-directory.js";

export interface ListCoworkersParams {
  /** When true, drop any cached entries before listing. Default false. */
  refresh?: boolean;
}

export interface ListCoworkersDeps {
  directory: CoworkerDirectory;
}

export interface ListCoworkersResult {
  success: boolean;
  count: number;
  coworkers: CoworkerEntry[];
}

export const listCoworkersTool = {
  name: "list_coworkers",
  description:
    "List the coworkers registered for this WhatsApp number. Returns canonical phone numbers " +
    "(digits only, no +) paired with display names from the operator's address book when " +
    'available. Use this to resolve a name a coworker mentioned (e.g. "dile a Aleyda") to ' +
    'a phone, or to answer "who is +52...?" when a coworker shares a number.',
  inputSchema: {
    type: "object" as const,
    properties: {
      refresh: {
        type: "boolean" as const,
        description: "If true, re-query the address book instead of returning cached entries.",
      },
    },
    required: [],
  },
  execute: async (
    params: ListCoworkersParams,
    deps: ListCoworkersDeps,
  ): Promise<ListCoworkersResult> => {
    if (params.refresh) {
      deps.directory.invalidate();
    }
    const coworkers = await deps.directory.list();
    return { success: true, count: coworkers.length, coworkers };
  },
};
