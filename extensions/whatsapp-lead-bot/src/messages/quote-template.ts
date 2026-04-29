/**
 * Canonical solar quote message sequence.
 *
 * Rules (updated 2026-04-29 per Aleyda):
 * 1. PDF always accompanies the full breakdown text.
 * 2. The breakdown is sent in ONE single message (contado + financiado).
 * 3. Respect spaces, bold (*text*), bullet points, accents.
 * 4. Calculations must match the PDF exactly.
 * 5. Intro message before the quote: "A continuación te comparto tu propuesta..."
 * 6. Close with an engagement question about timeline.
 *
 * Sequence (5 messages):
 *   [0] Pain — annual cost vs service number
 *   [1] Intro — invite to review the proposal
 *   [2] Full quote block — system + contado + financiado + 25yr + includes (ONE message)
 *   [3] PDF text (tool attaches pdfUrl as document)
 *   [4] Closing question
 */

export interface QuoteTemplateInput {
  serviceNumber: string;
  annualCost: number;
  twentyFiveYearProjection: number;
  coveragePercent: number;
  cashPrice: number;
  /** 50% of cashPrice — first deposit to start CFE paperwork. */
  depositPrice: number;
  financedPrice: number;
  annualSavings: number;
  paybackYears: number;
  panelCount: number;
  /** Panel wattage (e.g. 645). Used in system header. Defaults to 645 if omitted. */
  panelWattage?: number;
  /** Inverter brand label (e.g. "GROWATT"). Defaults to "GROWATT" if omitted. */
  inverterBrand?: string;
  /** CFE tariff code (e.g. "1F", "1A"). Shown in header when available. */
  tariff?: string;
  /** Annual consumption in kWh. Shown in header when available. */
  annualKwh?: number;
}

const FORMATTER = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });

export function fmt(n: number): string {
  return FORMATTER.format(Math.round(n));
}

export function fmtYears(years: number): string {
  return years.toFixed(1);
}

export function fmtKw(kw: number): string {
  return kw.toFixed(2);
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
    panelCount,
    panelWattage = 645,
    inverterBrand = "GROWATT",
    tariff,
    annualKwh,
  } = input;

  // Derived values
  const systemKw = (panelCount * panelWattage) / 1000;
  const installPayment = cashPrice * 0.3; // 30% on installation day
  const completionPayment = cashPrice * 0.2; // 20% when system is live
  const financedDeposit = financedPrice * 0.3;
  const monthlyPayment = (financedPrice * 0.7) / 24;

  // --- Message 0: Pain reflection ---
  const step0 =
    `Para su número de servicio ${serviceNumber}, con su consumo actual usted le paga a CFE ` +
    `aproximadamente $${fmt(annualCost)} al año.`;

  // --- Message 1: Intro ---
  const step1 =
    "A continuación te comparto tu propuesta personalizada y nuestras 2 opciones de financiamiento ☀️";

  // --- Message 2: Full quote block (ONE message) ---
  // System header
  const headerLine1 = `*Cotización Planta Solar de ${panelCount} paneles ${panelWattage}W → ${fmtKw(systemKw)} kW*`;
  const headerLine2 = `Inversor ${inverterBrand}`;

  // Build the tariff/consumption/coverage line conditionally
  const headerParts: string[] = [];
  if (tariff) {
    headerParts.push(`Tarifa: ${tariff}`);
  }
  if (annualKwh) {
    headerParts.push(`Consumo anual: ${fmt(annualKwh)} kWh`);
  }
  headerParts.push(`Cobertura: ${fmt(coveragePercent)}%`);
  const headerLine3 = headerParts.join(" | ");

  const quoteBlock = [
    headerLine1,
    headerLine2,
    headerLine3,
    "",
    "",
    "*Financiamiento básico – Precio de Contado:*",
    "",
    `Su precio de contado es de $${fmt(cashPrice)} MXN`,
    "",
    `• Se da el 50% de anticipo ($${fmt(depositPrice)}) para iniciar los trámites con CFE`,
    "",
    "El monto restante se paga bajo el siguiente esquema:",
    `• 30% ($${fmt(installPayment)}) el día de la instalación de las placas.`,
    `• 20% ($${fmt(completionPayment)}) al terminar y que su planta esté funcionando al 100%`,
    "",
    "",
    "*Financiamiento de hasta 24 meses*",
    "",
    `Su precio de lista es de $${fmt(financedPrice)} MXN`,
    "",
    `• Se da el 30% de anticipo ($${fmt(financedDeposit)})`,
    "",
    `El monto restante se paga hasta en *24 mensualidades de $${fmt(monthlyPayment)} MXN*`,
    "",
    "",
    `☀️ En 25 años sin paneles pagarás $${fmt(twentyFiveYearProjection)} MXN`,
    "",
    "La propuesta incluye:",
    "• Conexión y gestión de trámite de contratación de interconexión ante CFE",
    "• Cambio de medidor y sistema Wifi",
    "• Estructura de montaje de aluminio anonizado K2 para techo inclinado",
    "• Equipos de calidad mundial reconocida con certificado UL",
    "• Garantía de devolución de 90 días si no se cumplen los resultados de la cotización",
    "• Instalación",
  ].join("\n");

  const step2 = quoteBlock;

  // --- Message 3: PDF caption (tool attaches pdfUrl as document) ---
  const step3 = "Le comparto su cotización oficial en PDF con todos los detalles.";

  // --- Message 4: Closing engagement question ---
  const step4 =
    "¿Tiene alguna duda sobre la propuesta? También quisiera saber, ¿cuándo está planificando hacer la inversión en su planta solar?";

  return [step0, step1, step2, step3, step4];
}
