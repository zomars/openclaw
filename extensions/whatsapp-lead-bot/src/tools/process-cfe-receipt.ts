/**
 * Tool: process_cfe_receipt
 *
 * End-to-end CFE receipt → cotización pipeline. The LLM only provides the inbound
 * media path and the coworker phone; the tool handles parsing, official XML
 * download, lead persistence, quote calculation, and delivery atomically.
 *
 * Atomic / all-or-nothing: if any step fails, no quote is sent. The coworker
 * receives a clear error instead of a partial result.
 *
 * Tracer-bullet scope: the official CFE PDF render (XML → styled PDF) is
 * deferred. The XML path and parsed CFE data are returned and summarized in
 * the message; only the cotización PDF is sent as an attachment for now.
 */
import type { CFEBillData } from "../media/cfe-api-client.js";
import type { Runtime } from "../runtime.js";

export interface ProcessCFEReceiptParams {
  mediaPath: string;
  coworkerPhone: string;
}

export interface ParsedQuote {
  pdfUrl: string;
  panelCount: number;
  cashPrice: number;
  financedPrice: number;
  annualSavings: number;
  coveragePercent: number;
  paybackYears: number;
  systemKw?: number;
}

export interface ProcessCFEReceiptDeps {
  parseInboundReceipt: (mediaPath: string) => Promise<CFEBillData>;
  downloadOfficialXml: (input: {
    rpu: string;
    nombre: string;
  }) => Promise<{
    xmlPath: string;
    rpu: string;
    nombre: string;
    total?: number;
    annualKwh?: number;
  }>;
  saveLead: (input: { phone: string; name: string; notes?: string }) => Promise<{ leadId: number }>;
  saveReceiptData: (input: {
    leadId: number;
    receiptJson: string;
    tariff?: string;
    annualKwh?: number;
  }) => Promise<void>;
  calculateQuote: (
    billId: string,
  ) => Promise<{ success: true; quote: ParsedQuote } | { success: false; error: string }>;
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const ERR_PHOTO_UNREADABLE =
  "No pude leer este recibo. ¿Puedes mandar una foto más clara o el PDF original?";
const ERR_NOT_CFE = "Este archivo no parece ser un recibo CFE. Verifica que sea el oficial.";
const ERR_MISSING_FIELDS =
  "El recibo no tiene los datos completos (RPU o titular). Pide al cliente una foto más clara del recibo CFE.";
const ERR_CFE_PORTAL =
  "El portal CFE rechazó la consulta. Esto suele pasar cuando el nombre del titular no coincide exactamente con el RPU. Verifica el nombre como aparece en el recibo y reintenta.";
const ERR_QUOTE_FAILED =
  "Hubo un problema generando la cotización. Aleyda revisará en cuanto pueda.";
const ERR_INTERNAL = "Hubo un problema procesando el recibo. Aleyda revisará en cuanto pueda.";

const ACK_PROCESSING = "Procesando recibo, dame un momento...";

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    mediaPath: {
      type: "string" as const,
      description:
        "Absolute path to the inbound CFE receipt file (image or PDF) sent by the coworker",
    },
    coworkerPhone: {
      type: "string" as const,
      description:
        "Phone number of the coworker who sent the receipt (E.164 without +). Use the SENDER of the inbound message — never the lead/customer phone.",
    },
  },
  required: ["mediaPath", "coworkerPhone"],
};

export interface ProcessCFEReceiptResult {
  success: boolean;
  leadId?: number;
  sentToCoworker?: boolean;
  error?: string;
}

export const processCFEReceiptTool = {
  name: "process_cfe_receipt",
  description:
    "Process a CFE receipt (image or PDF) end-to-end: parse, download official XML from CFE, " +
    "create/update lead attributed to the coworker, calculate solar quote, and deliver the " +
    "quote PDF + summary to the coworker via WhatsApp. ATOMIC: returns success only after " +
    "everything (parse, official download, quote, send) completes. On any failure, sends a " +
    "clear error message to the coworker and returns success=false. Use this as the SINGLE " +
    "tool call when a coworker forwards a CFE receipt photo or PDF.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessCFEReceiptParams,
    deps: ProcessCFEReceiptDeps,
  ): Promise<ProcessCFEReceiptResult> => {
    const { mediaPath, coworkerPhone } = params;
    const { runtime } = deps;

    const sendErr = async (text: string): Promise<ProcessCFEReceiptResult> => {
      try {
        await runtime.sendMessage(coworkerPhone, {
          text,
          metadata: { openclawInitiated: true, source: "process_cfe_receipt:error" },
        });
      } catch (err) {
        console.error("[process_cfe_receipt] sendErr failed:", err);
      }
      return { success: false, error: text };
    };

    if (!mediaPath || !coworkerPhone) {
      return { success: false, error: "mediaPath and coworkerPhone are required" };
    }

    // 1. Ack
    try {
      await runtime.sendMessage(coworkerPhone, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "process_cfe_receipt:ack" },
      });
    } catch (err) {
      console.error("[process_cfe_receipt] ack send failed (continuing):", err);
    }

    // 2. Parse inbound to extract RPU + nombre + billId
    let inbound: CFEBillData;
    try {
      inbound = await deps.parseInboundReceipt(mediaPath);
    } catch (err) {
      console.error("[process_cfe_receipt] parseInboundReceipt threw:", err);
      return await sendErr(ERR_PHOTO_UNREADABLE);
    }

    if (inbound.error) {
      return await sendErr(
        inbound.error === "not_cfe_receipt" ? ERR_NOT_CFE : ERR_PHOTO_UNREADABLE,
      );
    }

    const rpu = inbound.numero_servicio?.replace(/\s/g, "");
    const nombre = inbound.nombre_titular?.trim();
    const billId = inbound.billId;
    if (!rpu || !nombre || !billId) {
      return await sendErr(ERR_MISSING_FIELDS);
    }

    // 3. Download official XML from CFE portal (validates name matches RPU)
    let official: Awaited<ReturnType<typeof deps.downloadOfficialXml>>;
    try {
      official = await deps.downloadOfficialXml({ rpu, nombre });
    } catch (err) {
      console.error("[process_cfe_receipt] downloadOfficialXml failed:", err);
      return await sendErr(ERR_CFE_PORTAL);
    }

    // 4. Persist lead attributed to the coworker
    let leadId: number;
    try {
      const saved = await deps.saveLead({
        phone: coworkerPhone,
        name: nombre,
        notes: `Cotización solicitada por coworker. RPU ${rpu}.`,
      });
      leadId = saved.leadId;
    } catch (err) {
      console.error("[process_cfe_receipt] saveLead failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    try {
      await deps.saveReceiptData({
        leadId,
        receiptJson: JSON.stringify(inbound),
        tariff: inbound.tarifa,
        annualKwh: official.annualKwh ?? inbound.calculado?.promedio_anual_kwh,
      });
    } catch (err) {
      console.error("[process_cfe_receipt] saveReceiptData failed (continuing):", err);
    }

    // 5. Calculate quote
    const quoteResult = await deps.calculateQuote(billId);
    if (!quoteResult.success) {
      console.error("[process_cfe_receipt] calculateQuote failed:", quoteResult.error);
      return await sendErr(ERR_QUOTE_FAILED);
    }
    const quote = quoteResult.quote;

    // 6. Download quote PDF locally so we can attach it
    let quotePdfPath: string;
    try {
      quotePdfPath = await deps.downloadFile(
        quote.pdfUrl,
        `${deps.outputDir}/cotizacion-${leadId}-${Date.now()}.pdf`,
      );
    } catch (err) {
      console.error("[process_cfe_receipt] downloadFile failed:", err);
      return await sendErr(ERR_QUOTE_FAILED);
    }

    // 7. Send quote PDF as attachment + structured summary
    const totalRecibo = official.total ?? inbound.monto_pagar_mxn;
    const annualKwh = official.annualKwh ?? inbound.calculado?.promedio_anual_kwh;
    const summary = buildSummaryMessage({
      titular: nombre,
      rpu,
      totalRecibo,
      annualKwh,
      tariff: inbound.tarifa,
      quote,
      xmlPath: official.xmlPath,
    });

    try {
      await runtime.sendMessage(coworkerPhone, {
        text: summary,
        metadata: {
          openclawInitiated: true,
          source: "process_cfe_receipt:result",
          filePath: quotePdfPath,
        },
      });
    } catch (err) {
      console.error("[process_cfe_receipt] final send failed:", err);
      return { success: false, error: "send_failed", leadId };
    }

    return { success: true, leadId, sentToCoworker: true };
  },
};

function buildSummaryMessage(input: {
  titular: string;
  rpu: string;
  totalRecibo?: number;
  annualKwh?: number;
  tariff?: string;
  quote: ParsedQuote;
  xmlPath: string;
}): string {
  const fmt = (n?: number): string =>
    typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString("es-MX")}` : "—";
  const kwh = (n?: number): string =>
    typeof n === "number" && Number.isFinite(n)
      ? `${Math.round(n).toLocaleString("es-MX")} kWh`
      : "—";

  return [
    `Cotización lista para *${input.titular}*`,
    "",
    `*Recibo CFE oficial descargado*`,
    `• RPU: ${input.rpu}`,
    `• Tarifa: ${input.tariff ?? "—"}`,
    `• Total último recibo: ${fmt(input.totalRecibo)}`,
    `• Consumo anual: ${kwh(input.annualKwh)}`,
    "",
    `*Sistema propuesto*`,
    `• Paneles: ${input.quote.panelCount}`,
    `• Cobertura: ${input.quote.coveragePercent}%`,
    `• Inversión contado: ${fmt(input.quote.cashPrice)}`,
    `• Inversión financiada: ${fmt(input.quote.financedPrice)}`,
    `• Ahorro anual: ${fmt(input.quote.annualSavings)}`,
    `• ROI: ${input.quote.paybackYears.toFixed(1)} años`,
  ].join("\n");
}
