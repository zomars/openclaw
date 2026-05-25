/**
 * Shared agent-visibility primitives. Used by both MCP server scoping
 * (`agents/bundle-mcp-config.ts`) and plugin scoping (`plugins/hooks.ts`) so
 * the rules for `allowAgents` / `denyAgents` stay consistent across surfaces.
 *
 * Default semantics (used by MCP, opt-out):
 *   - allowAgents absent  -> visible to every agent
 *   - allowAgents present -> visible only to listed agents
 *   - denyAgents present  -> subtracts from the visible set
 *
 * Plugins layer a stricter "opt-in" rule on top via `isPluginVisibleForAgent`.
 */

export type AgentVisibilityPolicy = {
  allowAgents?: unknown;
  denyAgents?: unknown;
};

export function normalizeAgentList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const resolved = value
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
    .filter(Boolean);
  return resolved.length > 0 ? Array.from(new Set(resolved)) : undefined;
}

const WILDCARD_AGENT = "*";

export function isVisibleForAgent(policy: AgentVisibilityPolicy, agentId?: string): boolean {
  const normalizedAgentId = agentId?.trim().toLowerCase();
  const allowAgents = normalizeAgentList(policy.allowAgents);
  const denyAgents = normalizeAgentList(policy.denyAgents);
  if (allowAgents && !matchesAgentList(allowAgents, normalizedAgentId)) {
    return false;
  }
  if (denyAgents && normalizedAgentId && denyAgents.includes(normalizedAgentId)) {
    return false;
  }
  return true;
}

/**
 * Plugin-flavored visibility. Plugins are strict opt-in: a missing or empty
 * `allowAgents` means the plugin is inert (no hooks fire, no tools surfaced).
 * Once `allowAgents` is provided, the same shared rules apply. Use `["*"]`
 * to explicitly opt in to every agent without listing them by name.
 */
export function isPluginVisibleForAgent(policy: AgentVisibilityPolicy, agentId?: string): boolean {
  if (!normalizeAgentList(policy.allowAgents)) {
    return false;
  }
  return isVisibleForAgent(policy, agentId);
}

function matchesAgentList(list: string[], agentId: string | undefined): boolean {
  if (list.includes(WILDCARD_AGENT)) {
    return true;
  }
  if (!agentId) {
    return false;
  }
  return list.includes(agentId);
}
