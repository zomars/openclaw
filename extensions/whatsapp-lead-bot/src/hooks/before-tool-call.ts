/**
 * before_tool_call hook — three-layer guardrail.
 *
 * Layer 1 (pricing): block any `message` tool call whose text contains
 * pricing, financing, panel counts, kWh, or percentages. Tells the LLM to
 * use a blinded tool instead.
 *
 * Layer 2 (tool gating): block tools that are not allowed in the lead's
 * current state. Prevents the LLM from skipping qualification steps even
 * when the prompt fails to constrain it.
 *
 * Layer 3 (strikes + escalation): increment a per-lead counter on every
 * pricing block. On the second strike in the same conversation, escalate
 * to a human via the injected onPricingEscalation callback (which calls
 * handoffManager + sends the canonical ack and notifies agent numbers).
 */

import type { Database } from "../database.js";
import { allowedToolsForState, isToolAllowedInState } from "../flow/allowed-tools.js";
import { computeLeadState, leadStateInputFromRow, type LeadState } from "../flow/state.js";
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from "../types.js";
import { agentIdFromSessionKey, phoneFromSessionKey } from "./before-prompt-build.js";
import type { ViolationTracker } from "./violation-tracker.js";

export interface PricingEscalationContext {
  phone: string;
  hit: PricingFilterHit;
  attemptCount: number;
  blockedText: string;
}

export interface BeforeToolCallHandlerDeps {
  /**
   * When true the hook only logs hits and does not block. Use during initial
   * rollout to surface false positives before enabling enforcement.
   */
  dryRun?: boolean;
  /**
   * Optional DB so the hook can compute the lead state for tool gating. When
   * omitted, only the pricing guardrail is enforced.
   */
  db?: Database;
  /**
   * Optional violation tracker for strike-based escalation. When omitted, the
   * pricing guardrail blocks but never escalates.
   */
  violations?: ViolationTracker;
  /**
   * Number of pricing strikes after which escalation fires (default 2).
   */
  pricingStrikeThreshold?: number;
  /**
   * Called when a lead crosses the pricing strike threshold. Implementations
   * typically: (1) trigger handoff via handoffManager, (2) send the canonical
   * "permítame un momento" ack to the customer, (3) notify Ale via agent
   * numbers with the blocked text + lead context. Errors are logged and
   * swallowed — escalation is best-effort and must never reflect failure
   * back to the LLM as a tool error.
   */
  onPricingEscalation?: (ctx: PricingEscalationContext) => Promise<void>;
  /**
   * Only enforce hooks (gating + pricing guard) when the invoking agent matches
   * this id. Without this, sibling agents (e.g. solayre-coworker) that share
   * the plugin's tools also get gated by the lead state machine, blocking
   * tools like process_cfe_receipt that don't belong to the lead funnel.
   */
  expectedAgentId?: string;
}

const FORBIDDEN_PRICING_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "currency_amount", re: /\$\s?[\d,]{3,}/ },
  { name: "amount_with_unit", re: /\b\d{1,3}(?:[.,]\d{3})+\s*(?:pesos|mxn|mn)\b/i },
  {
    name: "financing_terms",
    re: /\b(?:enganche|financia(?:do|miento)?|MSI|sin\s+intereses|de\s+contado)\b/i,
  },
  { name: "installments", re: /\b\d+\s*(?:meses|mensualidades|pagos|quincenas)\b/i },
  { name: "panel_count", re: /\b\d+\s*panel(?:es)?\b/i },
  { name: "kwh", re: /\b\d+(?:[.,]\d+)?\s*kw[h]?\b/i },
  { name: "percent", re: /\b\d{1,3}\s?%/ },
  { name: "roi", re: /\bROI\b|\bretorno\s+de\s+inversi[oó]n\b/i },
];

export interface PricingFilterHit {
  pattern: string;
  match: string;
}

export function checkPricingPatterns(text: string): PricingFilterHit | null {
  for (const { name, re } of FORBIDDEN_PRICING_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return { pattern: name, match: m[0] };
    }
  }
  return null;
}

const BLOCK_REASON_TEMPLATE =
  'Tu mensaje fue bloqueado por el guardrail. Detecté: "{match}" (regla: {pattern}). ' +
  "PROHIBIDO escribir precios, financiamiento, números de paneles, kWh o porcentajes en texto libre. " +
  "Usa el tool blindado correspondiente: " +
  "process_cfe_receipt_customer({ mediaPath, customerPhone }) para entregar la cotización oficial (PDF + resumen), " +
  "edit_quote({ quoteNumber, coworkerPhone, ... }) para ajustar una cotización existente, " +
  "send_disqualification(phone, reason) para descalificar OUT. " +
  "Reintenta este turno sin escribir cifras del sistema.";

function buildBlockReason(hit: PricingFilterHit): string {
  return BLOCK_REASON_TEMPLATE.replace("{match}", hit.match).replace("{pattern}", hit.pattern);
}

/**
 * Extract the outbound text from a `message` tool call's params, if present.
 * Returns null when this is not a `send` action with text.
 */
export function extractMessageText(params: Record<string, unknown>): string | null {
  const action = typeof params.action === "string" ? params.action : "send";
  if (action !== "send") {
    return null;
  }
  const message = params.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

async function leadStateForSession(
  db: Database,
  sessionKey: string | undefined,
): Promise<{ state: LeadState; phone: string } | null> {
  const phone = phoneFromSessionKey(sessionKey);
  if (!phone) {
    return null;
  }
  const lead = await db.getLeadByPhone(phone);
  if (!lead) {
    return null;
  }
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
  return { state, phone };
}

function buildToolGatingReason(toolName: string, state: LeadState): string {
  const allowed = allowedToolsForState(state);
  return (
    `Tool "${toolName}" no está permitido en estado ${state}. ` +
    `Tools permitidos ahora: ${allowed.join(", ")}. ` +
    "El estado lo determina el sistema desde los datos del lead — no lo cambies por tu cuenta. " +
    "Avanza el flujo guardando el dato correspondiente con save_lead."
  );
}

interface SessionContext {
  sessionKey?: string;
}

export function createBeforeToolCallHandler(deps: BeforeToolCallHandlerDeps = {}) {
  return async function onBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx?: SessionContext,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    // Bail entirely when the invoking agent isn't the lead bot. The plugin's
    // tools are intentionally shared (process_cfe_receipt etc.), but the
    // state machine and pricing guardrail are lead-funnel specific.
    if (deps.expectedAgentId) {
      const invokingAgent = agentIdFromSessionKey(ctx?.sessionKey);
      if (invokingAgent !== deps.expectedAgentId) {
        return;
      }
    }

    // Layer 2: tool gating (only when DB is wired and we can resolve a lead).
    if (deps.db && ctx?.sessionKey) {
      const resolved = await leadStateForSession(deps.db, ctx.sessionKey);
      if (resolved && !isToolAllowedInState(event.toolName, resolved.state)) {
        const blockReason = buildToolGatingReason(event.toolName, resolved.state);
        if (deps.dryRun) {
          console.warn(
            `[before-tool-call:gating] WOULD BLOCK ${event.toolName} in state=${resolved.state}`,
          );
        } else {
          console.warn(
            `[before-tool-call:gating] BLOCKED ${event.toolName} in state=${resolved.state}`,
          );
          return { block: true, blockReason };
        }
      }
    }

    // Layer 1: pricing guardrail on message tool.
    if (event.toolName !== "message") {
      return;
    }

    const text = extractMessageText(event.params);
    if (!text) {
      // Successful non-text message tool call → reset strike counter for this lead.
      if (deps.violations && ctx?.sessionKey) {
        const phone = phoneFromSessionKey(ctx.sessionKey);
        if (phone) {
          deps.violations.reset(phone);
        }
      }
      return;
    }

    const hit = checkPricingPatterns(text);
    if (!hit) {
      // Clean message tool call → reset strike counter for this lead.
      if (deps.violations && ctx?.sessionKey) {
        const phone = phoneFromSessionKey(ctx.sessionKey);
        if (phone) {
          deps.violations.reset(phone);
        }
      }
      return;
    }

    if (deps.dryRun) {
      console.warn(
        `[before-tool-call:guardrail] WOULD BLOCK message: pattern=${hit.pattern} match="${hit.match}"`,
      );
      return;
    }

    // Layer 3: strike counting + escalation.
    let attemptCount = 1;
    if (deps.violations && ctx?.sessionKey) {
      const phone = phoneFromSessionKey(ctx.sessionKey);
      if (phone) {
        attemptCount = deps.violations.increment(phone);
        const threshold = deps.pricingStrikeThreshold ?? 2;
        if (attemptCount >= threshold) {
          console.warn(
            `[before-tool-call:guardrail] ESCALATING after ${attemptCount} strikes for ${phone}: pattern=${hit.pattern}`,
          );
          if (deps.onPricingEscalation) {
            try {
              await deps.onPricingEscalation({
                phone,
                hit,
                attemptCount,
                blockedText: text,
              });
            } catch (err) {
              console.error(
                `[before-tool-call:guardrail] Escalation callback failed: ${String(err)}`,
              );
            }
          }
          deps.violations.reset(phone);
          return {
            block: true,
            blockReason:
              "Mensaje bloqueado y conversación escalada a un asesor humano por intentos repetidos de redactar precios. " +
              "No envíes más mensajes a este lead — el humano se hará cargo.",
          };
        }
      }
    }

    const blockReason = buildBlockReason(hit);
    console.warn(
      `[before-tool-call:guardrail] BLOCKED message (strike ${attemptCount}): pattern=${hit.pattern} match="${hit.match}"`,
    );
    return { block: true, blockReason };
  };
}
