/**
 * Per-state prompt fragments injected before each turn.
 *
 * These are the per-turn deltas. Stable rules (tone, format, red lines, tool
 * gating policy) live in the workspace system prompt (AGENTS.md, SOUL.md,
 * SALES.md) — repeating them here would inflate tokens and break prompt
 * cache. The plugin's before-tool-call hook enforces tool gating
 * deterministically; this prompt only tells the LLM what to compose this turn.
 */

import type { LeadState } from "./state.js";

const PROMPTS: Record<LeadState, string> = {
  NEW: 'Estado: NEW — saluda con "Buen día, gracias por escribirnos. ¿Qué tan altos le llegan sus recibos de luz?". Si el primer mensaje es una foto o PDF de recibo CFE, procésalo.',

  AWAITING_NAME: "Estado: AWAITING_NAME — pregunta el nombre del cliente.",

  AWAITING_LOCATION: "Estado: AWAITING_LOCATION — pregunta el municipio en Sinaloa.",

  AWAITING_OWNERSHIP: "Estado: AWAITING_OWNERSHIP — confirma si es propietario del inmueble.",

  AWAITING_PROPERTY_TYPE:
    "Estado: AWAITING_PROPERTY_TYPE — pregunta si el uso es habitacional o comercial.",

  AWAITING_BILL_AMOUNT:
    "Estado: AWAITING_BILL_AMOUNT — pregunta el monto bimestral aproximado del recibo.",

  AWAITING_RECEIPT:
    "Estado: AWAITING_RECEIPT — solicita el recibo CFE con send_receipt_request si aún no lo has pedido en esta conversación. Si ya lo solicitaste, espera. Cuando llegue una foto o PDF, procésalo según el flujo de SALES.md.",

  READY_TO_QUOTE:
    "Estado: READY_TO_QUOTE — invoca process_lead_cfe_receipt({ mediaPath, customerPhone }) para entregar la cotización oficial (resumen + PDF en un solo mensaje).",

  QUOTED:
    "Estado: QUOTED — la cotización ya fue enviada. Espera la reacción del cliente. Si pide visita o hablar con asesor, llama send_handoff_to_ale. Si un coworker pide ajustar la cotización (paneles, precio total, cobertura, datos del cliente), usa edit_quote({ quoteNumber, coworkerPhone, ... }).",

  DISQUALIFIED: "Estado: DISQUALIFIED — el cliente fue descalificado. No respondas más.",

  HANDED_OFF: "Estado: HANDED_OFF — el lead fue transferido a un asesor humano. No respondas más.",
};

export function buildStatePromptContext(state: LeadState): string {
  return PROMPTS[state];
}
