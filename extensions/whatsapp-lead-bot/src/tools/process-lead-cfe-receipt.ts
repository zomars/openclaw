/**
 * Tool: process_lead_cfe_receipt
 *
 * Customer-facing variant — the lead IS the customer. Single Supabase
 * parse-and-quote endpoint produces the cotización; we deliver one summary
 * message + PDF attachment to the customer.
 */
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  ParseAndQuoteResult,
} from "../cfe/parse-and-quote-client.js";
import type { Runtime } from "../runtime.js";

export interface ProcessLeadCFEReceiptParams {
  mediaPath: string;
  customerPhone: string;
}

export interface ProcessLeadCFEReceiptDeps {
  parseAndQuote: ParseAndQuoteClient["quote"];
  saveLead: (input: { phone: string; name: string; notes?: string }) => Promise<{ leadId: number }>;
  saveQuoteId: (input: { leadId: number; quoteId: string; quoteNumber: string }) => Promise<void>;
  downloadFile: (url: string, destPath: string) => Promise<string>;
  runtime: Runtime;
  outputDir: string;
}

const ERR_INTERNAL =
  "Tuve un problema procesando su recibo. Aleyda lo va a contactar para resolverlo.";
const ACK_PROCESSING = "Recibí su recibo, lo estoy procesando. Un momento por favor...";

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    mediaPath: {
      type: "string" as const,
      description:
        "Absolute path to the inbound CFE receipt file (image or PDF) sent by the customer",
    },
    customerPhone: {
      type: "string" as const,
      description:
        "Phone number of the customer who sent the receipt (E.164 without +). The customer IS the lead — never use a coworker phone here.",
    },
  },
  required: ["mediaPath", "customerPhone"],
};

export interface ProcessLeadCFEReceiptResult {
  success: boolean;
  leadId?: number;
  quoteId?: string;
  quoteNumber?: string;
  error?: string;
}

export const processLeadCFEReceiptTool = {
  name: "process_lead_cfe_receipt",
  description:
    "Process a CFE receipt (image or PDF) sent by a customer end-to-end via the consolidated " +
    "parse-and-quote endpoint. Saves lead under the customer's phone and delivers the quote PDF " +
    "+ summary to the customer via WhatsApp. ATOMIC: returns success only after everything " +
    "completes. On any failure, sends a friendly Spanish message to the customer and returns " +
    "success=false. Use this as the SINGLE tool call when a customer sends a CFE receipt.",
  inputSchema: inputJsonSchema,
  execute: async (
    params: ProcessLeadCFEReceiptParams,
    deps: ProcessLeadCFEReceiptDeps,
  ): Promise<ProcessLeadCFEReceiptResult> => {
    const { mediaPath, customerPhone } = params;
    const { runtime } = deps;

    const sendErr = async (text: string): Promise<ProcessLeadCFEReceiptResult> => {
      try {
        await runtime.sendMessage(customerPhone, {
          text,
          metadata: { openclawInitiated: true, source: "process_lead_cfe_receipt:error" },
        });
      } catch (err) {
        console.error("[process_lead_cfe_receipt] sendErr failed:", err);
      }
      return { success: false, error: text };
    };

    if (!mediaPath || !customerPhone) {
      return { success: false, error: "mediaPath and customerPhone are required" };
    }

    // 1. Ack
    try {
      await runtime.sendMessage(customerPhone, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "process_lead_cfe_receipt:ack" },
      });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] ack send failed (continuing):", err);
    }

    // 2. Single API call — parse + quote
    let result: ParseAndQuoteResult | ParseAndQuoteError;
    try {
      result = await deps.parseAndQuote({ mediaPath, phoneNumber: customerPhone });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] parseAndQuote threw:", err);
      return await sendErr(ERR_INTERNAL);
    }
    if (!result.success) {
      console.error("[process_lead_cfe_receipt] parseAndQuote failed:", result.error);
      return await sendErr(ERR_INTERNAL);
    }

    const customerName = result.cfe?.data?.customerName?.trim() || "Cliente";
    const serviceNumber = result.cfe?.data?.serviceNumber;

    // 3. Persist lead under the customer's phone
    let leadId: number;
    try {
      const saved = await deps.saveLead({
        phone: customerPhone,
        name: customerName,
        notes: `Recibo CFE procesado. RPU ${serviceNumber ?? "?"}. Cotización ${result.quoteNumber}.`,
      });
      leadId = saved.leadId;
    } catch (err) {
      console.error("[process_lead_cfe_receipt] saveLead failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    // 4. Save quote reference (best-effort)
    try {
      await deps.saveQuoteId({
        leadId,
        quoteId: result.quoteId,
        quoteNumber: result.quoteNumber,
      });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] saveQuoteId failed (continuing):", err);
    }

    // 5. Download quote PDF locally
    let quotePdfPath: string;
    try {
      quotePdfPath = await deps.downloadFile(
        result.pdfUrl,
        `${deps.outputDir}/cotizacion-${leadId}-${Date.now()}.pdf`,
      );
    } catch (err) {
      console.error("[process_lead_cfe_receipt] downloadFile failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    // 6. Send summary + attachment
    const summary = buildSummaryMessage({
      quote: result.quote,
      cfe: result.cfe,
    });

    try {
      await runtime.sendMessage(customerPhone, {
        text: summary,
        metadata: {
          openclawInitiated: true,
          source: "process_lead_cfe_receipt:result",
          filePath: quotePdfPath,
        },
      });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] final send failed:", err);
      return { success: false, error: "send_failed", leadId };
    }

    return {
      success: true,
      leadId,
      quoteId: result.quoteId,
      quoteNumber: result.quoteNumber,
    };
  },
};

function buildSummaryMessage(input: {
  quote: ParseAndQuoteResult["quote"];
  cfe: ParseAndQuoteResult["cfe"];
}): string {
  const fmtMoney = (n: number): string => `$${Math.round(n).toLocaleString("es-MX")}`;
  const fmtNumber = (n: number, digits = 0): string =>
    n.toLocaleString("es-MX", { maximumFractionDigits: digits });
  const fmtYears = (n: number): string => n.toFixed(1);

  const serviceNumber = input.cfe.data.serviceNumber;
  const annualConsumption = input.cfe.data.annualConsumption;

  return [
    `En su medidor ${serviceNumber}, el ultimo año gasto ${fmtNumber(annualConsumption)} KWh`,
    `Para cubrir el ${fmtNumber(input.quote.coveragePercent)}% de consumo, necesitamos producir ${fmtNumber(input.quote.systemKw, 2)} kW de energia`,
    `Serían ${fmtNumber(input.quote.panelCount)} paneles de ${fmtNumber(input.quote.panelWattage)}W.`,
    "Tienen una garantía de 25 años de producción.",
    `Si seguimos sin placas solares en 25 años pagará ${fmtMoney(input.quote.fomo25Years)} de luz a la CFE.`,
    `El precio de la plana financiada es de ${fmtMoney(input.quote.financedPrice)} hasta 4 años`,
    `El precio de contado es de ${fmtMoney(input.quote.cashPrice)} (pagando 50% de anticipo instalamos por completo y se liquida en menos de 2 meses posteriores a la instalacaion)`,
    `Aprovechando el precio de contado el retorno de inversion se cumple en ${fmtYears(input.quote.paybackYears)} años`,
    `Y en 25 años que es la garantía de rendimiento de las placas, habra recuperado el ${fmtNumber(input.quote.roi25YearsPercent)}% de lo invertido.`,
    "Le comparto el documento con todos los detalles",
  ].join("\n");
}
