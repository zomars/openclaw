/**
 * Parse-and-Quote API Client
 *
 * Single multipart POST to the consolidated Supabase parse-and-quote endpoint.
 * Replaces the prior parseCFEBill + downloadOfficialXml + calculateQuote chain.
 */

import * as fs from "node:fs";

export interface ParseAndQuoteResult {
  success: true;
  quoteId: string;
  quoteNumber: string;
  pdfUrl: string;
  quote: {
    panelCount: number;
    cashPrice: number;
    financedPrice: number;
    annualSavings: number;
    coveragePercent: number;
    paybackYears: number;
    systemKw?: number;
  };
  cfe?: {
    data?: {
      customerName?: string;
      serviceNumber?: string;
      tariffType?: string;
      annualConsumption?: number;
    };
  };
}

export interface ParseAndQuoteError {
  success: false;
  error: string;
}

export interface ParseAndQuoteClient {
  quote(input: {
    mediaPath: string;
    phoneNumber: string;
  }): Promise<ParseAndQuoteResult | ParseAndQuoteError>;
}

interface ClientDeps {
  apiKey: string;
  apiUrl: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function detectFileType(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 4 && buffer.toString("utf-8", 0, 4).startsWith("%PDF")) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (buffer.length >= 4 && buffer.toString("utf-8", 0, 4).startsWith("\x89PNG")) {
    return { mime: "image/png", ext: "png" };
  }
  if (buffer.length >= 12 && buffer.toString("utf-8", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function createParseAndQuoteClient(deps: ClientDeps): ParseAndQuoteClient {
  return {
    async quote({ mediaPath, phoneNumber }) {
      if (!mediaPath || !phoneNumber) {
        return { success: false, error: "mediaPath and phoneNumber are required" };
      }
      if (!fs.existsSync(mediaPath)) {
        return { success: false, error: `File not found: ${mediaPath}` };
      }
      const stats = fs.statSync(mediaPath);
      if (stats.size > MAX_FILE_BYTES) {
        return { success: false, error: `File too large: ${stats.size} bytes (max 10MB)` };
      }
      const buffer = fs.readFileSync(mediaPath);
      const detected = detectFileType(buffer);
      if (!detected) {
        return { success: false, error: `Unsupported file type: ${mediaPath}` };
      }

      const form = new FormData();
      const blob = new Blob([buffer], { type: detected.mime });
      form.append("file", blob, `receipt.${detected.ext}`);
      form.append("phone_number", phoneNumber);

      let response: Response;
      try {
        response = await fetch(deps.apiUrl, {
          method: "POST",
          headers: { "X-API-Key": deps.apiKey },
          body: form,
        });
      } catch (err) {
        return { success: false, error: `network error: ${String(err)}` };
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          // ignore
        }
        return { success: false, error: `HTTP ${response.status}: ${body.slice(0, 500)}` };
      }

      let json: Record<string, unknown>;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch (err) {
        return { success: false, error: `invalid JSON response: ${String(err)}` };
      }

      if (json.success !== true) {
        const errMsg =
          typeof json.error === "string" ? json.error : "parse-and-quote returned success=false";
        return { success: false, error: errMsg };
      }

      const q = (json.quote ?? {}) as Record<string, unknown>;
      const quoteId = str(json.quoteId);
      const quoteNumber = str(json.quoteNumber);
      const pdfUrl = str(json.pdfUrl);
      const panelCount = num(q.panelCount);
      const cashPrice = num(q.cashPrice);
      const financedPrice = num(q.financedPrice);
      const annualSavings = num(q.annualSavings);
      const coveragePercent = num(q.coveragePercent);
      const paybackYears = num(q.paybackYears);

      const required = {
        quoteId,
        quoteNumber,
        pdfUrl,
        panelCount,
        cashPrice,
        financedPrice,
        annualSavings,
        coveragePercent,
        paybackYears,
      };
      for (const [k, v] of Object.entries(required)) {
        if (typeof v === "number" ? !Number.isFinite(v) : !v) {
          return { success: false, error: `response missing field: ${k}` };
        }
      }

      const systemKwRaw = num(q.systemKw);
      const cfe = (json.cfe ?? undefined) as ParseAndQuoteResult["cfe"];

      return {
        success: true,
        quoteId: quoteId as string,
        quoteNumber: quoteNumber as string,
        pdfUrl: pdfUrl as string,
        quote: {
          panelCount,
          cashPrice,
          financedPrice,
          annualSavings,
          coveragePercent,
          paybackYears,
          ...(Number.isFinite(systemKwRaw) ? { systemKw: systemKwRaw } : {}),
        },
        cfe,
      };
    },
  };
}
