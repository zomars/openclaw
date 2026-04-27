/**
 * Canonical 6-step solar quote message sequence.
 *
 * The LLM never writes any of this copy. The tool reads pricing from the
 * Supabase quote API and renders these templates server-side. The exact wording
 * mirrors workspace-solayre-leads/_guides/cotizacion.md, which is now
 * considered legacy guidance for the LLM — this file is the source of truth.
 */

export interface QuoteTemplateInput {
  serviceNumber: string;
  annualCost: number;
  twentyFiveYearProjection: number;
  coveragePercent: number;
  cashPrice: number;
  depositPrice: number;
  financedPrice: number;
  annualSavings: number;
  paybackYears: number;
}

const FORMATTER = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });

export function fmt(n: number): string {
  return FORMATTER.format(Math.round(n));
}

export function fmtYears(years: number): string {
  return years.toFixed(1);
}

export function buildQuoteMessages(input: QuoteTemplateInput): string[] {
  const {
    serviceNumber,
    annualCost,
    twentyFiveYearProjection,
    coveragePercent,
    cashPrice,
    depositPrice,
    financedPrice,
    annualSavings,
    paybackYears,
  } = input;

  const step1 =
    `Para su número de servicio ${serviceNumber}, con su consumo actual usted le paga a CFE ` +
    `aproximadamente $${fmt(annualCost)} al año.`;

  const step2 =
    `Si sigue igual, en 25 años habrá pagado $${fmt(twentyFiveYearProjection)} a CFE solo en electricidad. ` +
    `Sin contar los aumentos de tarifa.`;

  const step3 = [
    `El sistema SOLAYRE que le corresponde cubre el ${fmt(coveragePercent)}% de su consumo.`,
    "Incluye todo lo necesario para que no tenga que preocuparse por nada:",
    "Paneles solares bifaciales de alta eficiencia",
    "Inversor con monitoreo en tiempo real desde su celular",
    "Estructura de montaje de aluminio profesional",
    "Instalación certificada con mano de obra incluida",
    "Gestión completa de trámites ante CFE y cambio de medidor",
  ].join("\n");

  const step4 = [
    `El precio de contado es de $${fmt(cashPrice)} MXN.`,
    `Para iniciar, el anticipo es de $${fmt(depositPrice)} MXN (50% del precio de contado).`,
    "Si liquida el resto en menos de 2 meses, se respeta ese precio.",
    `También tenemos opción de financiamiento a $${fmt(financedPrice)} MXN en hasta 24 meses.`,
  ].join("\n");

  const step5 = "Le comparto su cotización en PDF con todos los detalles.";

  const step6 =
    `Con un ahorro de $${fmt(annualSavings)} al año, su inversión se recupera en ${fmtYears(paybackYears)} años. ` +
    `Los siguientes 22 años el ahorro es puro beneficio para usted.`;

  return [step1, step2, step3, step4, step5, step6];
}
