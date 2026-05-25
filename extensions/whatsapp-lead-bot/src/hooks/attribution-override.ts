/**
 * before_tool_call hook — deterministic lead attribution.
 *
 * For tools that persist or operate on a lead/coworker phone, the param
 * naming the phone (`coworkerPhone`, `customerPhone`, or `phone`) is
 * sourced from the runtime sender so attribution stays anchored to the
 * verified peer. The runtime sender comes from the inbound message's
 * peer encoded in `ctx.sessionKey`.
 *
 * Why: routing to the agent is already deterministic via bindings; this
 * hook makes the persisted phone equally deterministic by anchoring it
 * to the verified sender. Attribution stays correct even when the model
 * reads a different phone from the message body (the receipt's titular,
 * a number quoted in conversation, another participant).
 *
 * Strict mode: when the sessionKey carries a usable direct peer, the
 * hook injects it. When the sessionKey only carries a group or
 * non-direct scope, the hook blocks the call so attribution remains
 * tied to a verified peer — group/non-direct flows belong to a
 * different tool path.
 *
 * The diff between the LLM-supplied phone and the runtime phone is
 * logged so we can observe how often the model's attribution diverged
 * from the runtime sender.
 */

import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from "../types.js";
import { phoneFromSessionKey } from "./before-prompt-build.js";

interface SessionContext {
  sessionKey?: string;
}

const ATTRIBUTED_TOOLS: Record<string, "customerPhone" | "phone"> = {
  process_lead_cfe_receipt: "customerPhone",
  save_lead: "phone",
};

function stripPlus(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}

export function createAttributionOverrideHandler() {
  return function onBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx?: SessionContext,
  ): PluginHookBeforeToolCallResult | void {
    const paramName = ATTRIBUTED_TOOLS[event.toolName];
    if (!paramName) {
      return;
    }

    const runtimePhoneRaw = phoneFromSessionKey(ctx?.sessionKey);
    if (!runtimePhoneRaw) {
      const blockReason =
        `Atribución requiere un peer direct en el sessionKey. ` +
        `Tool ${event.toolName} se ancla al sender verificado para mantener atribución determinista. ` +
        `Para flujos de grupo o sin peer, usa un tool diferente que no requiera atribución 1-a-1.`;
      console.warn(
        `[attribution-override] BLOCKED ${event.toolName}: sessionKey lacks direct peer (got ${ctx?.sessionKey ?? "<none>"})`,
      );
      return { block: true, blockReason };
    }

    const runtimePhone = stripPlus(runtimePhoneRaw);
    const llmPhoneRaw = event.params[paramName];
    const llmPhone = typeof llmPhoneRaw === "string" ? stripPlus(llmPhoneRaw) : undefined;

    if (llmPhone && llmPhone !== runtimePhone) {
      console.warn(
        `[attribution-override] ${event.toolName}: LLM ${paramName}=${llmPhone} != runtime ${runtimePhone} — overriding with runtime`,
      );
    }

    if (llmPhone === runtimePhone) {
      return;
    }

    return {
      params: { ...event.params, [paramName]: runtimePhone },
    };
  };
}
