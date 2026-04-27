import type { Lead } from "../database/schema.js";

export const HANDOFF_CUSTOMER_ACK =
  "Con gusto, en breve le comunicaremos con un asesor para coordinar los detalles.";

export function handoffCustomerAckMessage(): string {
  return HANDOFF_CUSTOMER_ACK;
}

/**
 * Build a natural-language summary line for the agent (Ale) describing the lead.
 * No markdown, no technical terms — reads like a coworker handing off in chat.
 */
export function handoffAgentMessage(lead: Lead): string {
  const name = lead.name || "Un prospecto";
  const phone = lead.phone_number;

  const contextParts: string[] = [];
  if (lead.location) {
    contextParts.push(`Está en ${lead.location}`);
  }
  if (typeof lead.bimonthly_bill === "number" && lead.bimonthly_bill > 0) {
    contextParts.push(
      `su recibo bimestral es de aproximadamente $${lead.bimonthly_bill.toLocaleString("es-MX")}`,
    );
  }
  if (lead.property_type) {
    contextParts.push(`uso ${lead.property_type}`);
  }

  const contextLine =
    contextParts.length > 0 ? `${contextParts.join(", ")}.` : "Aún sin información detallada.";

  return `Hola Ale, ${name} quiere agendar una visita. Su número es ${phone}. ${contextLine}`;
}
