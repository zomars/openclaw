/**
 * before_prompt_build hook — injects the current lead state into the agent's
 * per-turn context so the LLM sees a single explicit instruction for what to
 * do next, derived deterministically from the lead's data.
 *
 * The state is computed from the persisted Lead row (via computeLeadState),
 * not from the prompt or conversation history.
 */

import type { Database } from "../database.js";
import { buildStatePromptContext } from "../flow/state-prompts.js";
import { computeLeadState, leadStateInputFromRow } from "../flow/state.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "../types.js";

export interface BeforePromptBuildHandlerDeps {
  db: Database;
  /**
   * Only inject the lead state prompt when the invoking agent matches this id.
   * Without this, sibling agents (e.g. solayre-coworker) that share the plugin's
   * tools also receive the lead state machine prompt, which corrupts their
   * behavior with state belonging to a different conversation.
   */
  expectedAgentId?: string;
}

/**
 * Extract the lead phone number from a sessionKey of the form:
 *   agent:<agentId>:<channel>:<accountId>:direct:<phone>
 */
export function phoneFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  if (parts.length < 6) return null;
  if (parts[0] !== "agent") return null;
  if (parts[parts.length - 2] !== "direct") return null;
  const phone = parts[parts.length - 1];
  return phone && phone.length > 0 ? phone : null;
}

/**
 * Extract the agent id from a sessionKey of the form:
 *   agent:<agentId>:<channel>:<accountId>:direct:<phone>
 */
export function agentIdFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");
  if (parts.length < 2) return null;
  if (parts[0] !== "agent") return null;
  return parts[1] || null;
}

export function createBeforePromptBuildHandler(deps: BeforePromptBuildHandlerDeps) {
  return async function onBeforePromptBuild(
    _event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | void> {
    if (ctx.channelId !== "whatsapp") return;

    if (deps.expectedAgentId) {
      const invokingAgent = agentIdFromSessionKey(ctx.sessionKey);
      if (invokingAgent !== deps.expectedAgentId) return;
    }

    const phone = phoneFromSessionKey(ctx.sessionKey);
    if (!phone) return;

    const lead = await deps.db.getLeadByPhone(phone);
    if (!lead) return;

    const state = computeLeadState(
      leadStateInputFromRow({
        status: lead.status,
        name: lead.name,
        location: lead.location,
        ownership: lead.ownership,
        property_type: lead.property_type,
        bimonthly_bill: lead.bimonthly_bill,
        panels_quoted: lead.panels_quoted,
        receipt_data: lead.receipt_data,
      }),
    );

    return { prependContext: buildStatePromptContext(state) };
  };
}
