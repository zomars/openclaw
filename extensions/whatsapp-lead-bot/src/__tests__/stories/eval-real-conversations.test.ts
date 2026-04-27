/**
 * Replay of representative LLM hallucinations seen in production. These are
 * the patterns the agent was producing that caused this whole rewrite — the
 * eval guarantees that for each one, the guardrail blocks (and on the second
 * occurrence in a row, escalates).
 *
 * If a real hallucinated message is added here as a fixture and the test
 * passes, it cannot regress silently. Add new fixtures whenever the team
 * spots a new failure mode.
 */

import { describe, it, expect } from "vitest";
import {
  checkPricingPatterns,
  createBeforeToolCallHandler,
  type PricingEscalationContext,
} from "../../hooks/before-tool-call.js";
import { ViolationTracker } from "../../hooks/violation-tracker.js";

interface HallucinationFixture {
  name: string;
  text: string;
  expectedPattern: string;
}

const HALLUCINATIONS: HallucinationFixture[] = [
  {
    name: "naked cash price",
    text: "El sistema completo le sale en $185,000 de contado.",
    expectedPattern: "currency_amount",
  },
  {
    name: "MSI offer (forbidden)",
    text: "También tenemos opción de 24 meses sin intereses.",
    expectedPattern: "financing_terms",
  },
  {
    name: "panel count fabricated",
    text: "Para su consumo necesitaría aproximadamente 12 paneles.",
    expectedPattern: "panel_count",
  },
  {
    name: "coverage percentage made up",
    text: "Cubriría el 85% de su consumo eléctrico anual.",
    expectedPattern: "percent",
  },
  {
    name: "annual cost projection",
    text: "Usted le paga a CFE alrededor de $22,000 al año.",
    expectedPattern: "currency_amount",
  },
  {
    name: "ROI claim",
    text: "El retorno de inversión sería de 4 años aproximadamente.",
    expectedPattern: "roi",
  },
  {
    name: "amount in pesos written out",
    text: "Su cotización quedó en 180,000 pesos.",
    expectedPattern: "amount_with_unit",
  },
  {
    name: "kWh detail",
    text: "Su consumo anual ronda los 1500 kWh.",
    expectedPattern: "kwh",
  },
  {
    name: "deposit in installments",
    text: "El enganche se queda en 90,000 y el resto a 18 meses.",
    expectedPattern: "financing_terms",
  },
  {
    name: "naked figure as confirmation",
    text: "Entendido, $1,500 bimestral.",
    expectedPattern: "currency_amount",
  },
];

const CLEAN_MESSAGES = [
  "Buen día, gracias por escribirnos. ¿Qué tan altos le llegan sus recibos de luz?",
  "¿Con quién tengo el gusto?",
  "¿En qué municipio de Sinaloa se encuentra su propiedad?",
  "¿Es usted el propietario del inmueble donde se instalaría el sistema?",
  "¿Es uso habitacional o comercial?",
  "Para cotizarle de forma precisa necesito ver su recibo de CFE. ¿Lo tiene a la mano?",
  "Con gusto, en breve le comunicaremos con un asesor para coordinar los detalles.",
  "Permítame un momento, le confirmo con un asesor.",
  "Entendido, gracias por la información.",
  "Por el momento solo operamos en Sinaloa. Agradezco su interés.",
];

describe("Eval: real hallucination patterns", () => {
  it.each(HALLUCINATIONS)(
    "blocks: $name",
    ({ text, expectedPattern }) => {
      const hit = checkPricingPatterns(text);
      expect(hit, `expected hit for: ${text}`).not.toBeNull();
      expect(hit?.pattern).toBe(expectedPattern);
    },
  );

  it.each(CLEAN_MESSAGES)("passes clean message: %s", (text) => {
    expect(checkPricingPatterns(text)).toBeNull();
  });

  it("escalates after 2 different hallucination patterns in the same session", async () => {
    const violations = new ViolationTracker();
    const escalations: PricingEscalationContext[] = [];
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async (c) => {
        escalations.push(c);
      },
    });
    const sessionKey = "agent:solayre-leads:whatsapp:default:direct:526671000080";

    await handler(
      {
        toolName: "message",
        params: { action: "send", target: "whatsapp:526671000080", message: HALLUCINATIONS[0].text },
      },
      { sessionKey },
    );

    const second = await handler(
      {
        toolName: "message",
        params: { action: "send", target: "whatsapp:526671000080", message: HALLUCINATIONS[1].text },
      },
      { sessionKey },
    );

    expect(second?.block).toBe(true);
    expect(second?.blockReason).toContain("escalada");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].phone).toBe("526671000080");
  });

  it("happy path: clean qualification flow never trips the guardrail", async () => {
    const violations = new ViolationTracker();
    const handler = createBeforeToolCallHandler({
      violations,
      pricingStrikeThreshold: 2,
      onPricingEscalation: async () => {
        // noop
      },
    });
    const sessionKey = "agent:solayre-leads:whatsapp:default:direct:526671000081";

    for (const text of CLEAN_MESSAGES) {
      const result = await handler(
        {
          toolName: "message",
          params: { action: "send", target: "whatsapp:526671000081", message: text },
        },
        { sessionKey },
      );
      expect(result, `clean message must pass: ${text}`).toBeUndefined();
    }
    expect(violations.count("526671000081")).toBe(0);
  });
});
