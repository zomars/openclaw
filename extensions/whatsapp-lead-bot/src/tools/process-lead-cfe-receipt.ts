/**
 * Tool: process_lead_cfe_receipt
 *
 * Customer-facing variant. The tool submits the receipt quickly and persists
 * an async delivery job; a background worker owns polling and WhatsApp delivery.
 */
import type {
  ParseAndQuoteClient,
  ParseAndQuoteError,
  ParseAndQuoteResult,
  SubmitQuoteReceiptResult,
} from "../cfe/parse-and-quote-client.js";
import type { PendingQuoteJob } from "../database/schema.js";
import type { Runtime } from "../runtime.js";

export interface ProcessLeadCFEReceiptParams {
  mediaPath: string;
  customerPhone: string;
}

export interface ProcessLeadCFEReceiptDeps {
  submitReceipt: ParseAndQuoteClient["submitReceipt"];
  createPendingQuoteJob: (input: {
    requestId: string;
    customerPhone: string;
    mediaPath: string;
    agentSessionKey?: string | null;
    agentSessionId?: string | null;
    invokingAgentId?: string | null;
    nextPollAt?: number;
  }) => Promise<number>;
  findPendingQuoteJobByCustomerMedia?: (input: {
    customerPhone: string;
    mediaPath: string;
  }) => Promise<PendingQuoteJob | null>;
  agentSessionKey?: string | null;
  agentSessionId?: string | null;
  invokingAgentId?: string | null;
  nextPollDelayMs?: number;
  runtime: Runtime;
}

export interface DeliverLeadCFEQuoteDeps {
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
  mode?: "queued";
  requestId?: string;
  jobId?: number;
  leadId?: number;
  quoteId?: string;
  quoteNumber?: string;
  error?: string;
}

export const processLeadCFEReceiptTool = {
  name: "process_lead_cfe_receipt",
  description:
    "Queue a CFE receipt (image or PDF) sent by a customer for the consolidated parse-and-quote " +
    "endpoint. Sends an immediate receipt acknowledgement, persists the async quote request for " +
    "background delivery, and returns quickly with mode=queued. The background worker sends the " +
    "quote PDF + summary when Lovable/Supabase finishes.",
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

    if (deps.findPendingQuoteJobByCustomerMedia) {
      const existingJob = await deps.findPendingQuoteJobByCustomerMedia({
        customerPhone,
        mediaPath,
      });
      if (existingJob) {
        return {
          success: true,
          mode: "queued",
          requestId: existingJob.request_id,
          jobId: existingJob.id,
        };
      }
    }

    try {
      await runtime.sendMessage(customerPhone, {
        text: ACK_PROCESSING,
        metadata: { openclawInitiated: true, source: "process_lead_cfe_receipt:ack" },
      });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] ack send failed (continuing):", err);
    }

    let submitted: SubmitQuoteReceiptResult | ParseAndQuoteError;
    try {
      submitted = await deps.submitReceipt({ mediaPath, phoneNumber: customerPhone });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] submitReceipt threw:", err);
      return await sendErr(ERR_INTERNAL);
    }
    if (!submitted.success) {
      console.error("[process_lead_cfe_receipt] submitReceipt failed:", submitted.error);
      return await sendErr(ERR_INTERNAL);
    }

    let jobId: number;
    try {
      jobId = await deps.createPendingQuoteJob({
        requestId: submitted.requestId,
        customerPhone,
        mediaPath,
        agentSessionKey: deps.agentSessionKey ?? null,
        agentSessionId: deps.agentSessionId ?? null,
        invokingAgentId: deps.invokingAgentId ?? null,
        nextPollAt: Date.now() + (deps.nextPollDelayMs ?? 0),
      });
    } catch (err) {
      console.error("[process_lead_cfe_receipt] createPendingQuoteJob failed:", err);
      return await sendErr(ERR_INTERNAL);
    }

    return { success: true, mode: "queued", requestId: submitted.requestId, jobId };
  },
};

export async function deliverLeadCFEQuote(input: {
  customerPhone: string;
  result: ParseAndQuoteResult;
  deps: DeliverLeadCFEQuoteDeps;
}): Promise<ProcessLeadCFEReceiptResult> {
  const { customerPhone, result, deps } = input;
  const customerName = result.cfe?.data?.customerName?.trim() || "Cliente";
  const serviceNumber = result.cfe?.data?.serviceNumber;

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
    return { success: false, error: ERR_INTERNAL };
  }

  try {
    await deps.saveQuoteId({
      leadId,
      quoteId: result.quoteId,
      quoteNumber: result.quoteNumber,
    });
  } catch (err) {
    console.error("[process_lead_cfe_receipt] saveQuoteId failed (continuing):", err);
  }

  let quotePdfPath: string;
  try {
    quotePdfPath = await deps.downloadFile(
      result.pdfUrl,
      `${deps.outputDir}/cotizacion-${leadId}-${Date.now()}.pdf`,
    );
  } catch (err) {
    console.error("[process_lead_cfe_receipt] downloadFile failed:", err);
    return { success: false, error: ERR_INTERNAL, leadId };
  }

  const summary = buildSummaryMessage({
    quote: result.quote,
    cfe: result.cfe,
  });

  try {
    await deps.runtime.sendMessage(customerPhone, {
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
}

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
