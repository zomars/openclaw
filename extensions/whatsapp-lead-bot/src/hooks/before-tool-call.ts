/**
 * before_tool_call hook — guardrail against hallucinated pricing in `message` tool.
 *
 * Phase 1 (slice 1): block any `message` tool call whose text contains pricing,
 * financing, panel counts, kWh, or percentages. Tells the LLM to use a blinded
 * tool instead.
 *
 * Future slices add: strike counter + escalation, tool gating per state.
 */

import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult } from "../types.js";

export interface BeforeToolCallHandlerDeps {
  /**
   * When true the hook only logs hits and does not block. Use during initial
   * rollout to surface false positives before enabling enforcement.
   */
  dryRun?: boolean;
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
  "send_quote_sequence(billId) para cotizar, " +
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

export function createBeforeToolCallHandler(deps: BeforeToolCallHandlerDeps = {}) {
  return function onBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
  ): PluginHookBeforeToolCallResult | void {
    if (event.toolName !== "message") {
      return;
    }

    const text = extractMessageText(event.params);
    if (!text) {
      return;
    }

    const hit = checkPricingPatterns(text);
    if (!hit) {
      return;
    }

    if (deps.dryRun) {
      console.warn(
        `[before-tool-call:guardrail] WOULD BLOCK message: pattern=${hit.pattern} match="${hit.match}"`,
      );
      return;
    }

    const blockReason = buildBlockReason(hit);
    console.warn(
      `[before-tool-call:guardrail] BLOCKED message: pattern=${hit.pattern} match="${hit.match}"`,
    );
    return { block: true, blockReason };
  };
}
