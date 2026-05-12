/**
 * Parse-and-Quote API Client
 *
 * Async flow: POST /parse-and-quote → 202 + requestId → poll GET /check-request/{id}
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
    listPrice: number;
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

export interface EditQuoteInput {
  /** Original quote folio (e.g. "SOL20260402-170c") OR quoteId UUID. */
  quoteNumber: string;
  panels?: number;
  totalInvestment?: number;
  inverterKw?: number;
  /** 0-100 */
  targetCoverage?: number;
  clientInfo?: {
    name?: string;
    phone?: string;
    email?: string;
    city?: string;
    serviceNumber?: string;
    serviceAddress?: string;
  };
}

export interface EditQuoteResult {
  success: true;
  quoteId: string;
  quoteNumber: string;
  version: number;
  parentQuoteId?: string;
  pdfUrl: string;
  /** Recomputed system summary, when present in the response. */
  quote?: ParseAndQuoteResult["quote"];
}

export interface ParseAndQuoteClient {
  quote(input: {
    mediaPath: string;
    phoneNumber: string;
  }): Promise<ParseAndQuoteResult | ParseAndQuoteError>;
  editQuote(input: EditQuoteInput): Promise<EditQuoteResult | ParseAndQuoteError>;
}

export interface ClientDeps {
  apiKey: string;
  apiUrl: string;
  /** Synchronous quote-revision endpoint (calculate-quote). */
  editQuoteUrl: string;
  /** Polling interval in ms (default 2500) */
  pollIntervalMs?: number;
  /** Total timeout in ms (default 120000) */
  timeoutMs?: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 120_000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrl(apiUrl: string): string {
  // apiUrl points to /parse-and-quote — derive base for /check-request
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/parse-and-quote\/?$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateResult(json: Record<string, unknown>): ParseAndQuoteResult | ParseAndQuoteError {
  const q = (json.quote ?? {}) as Record<string, unknown>;
  const quoteId = str(json.quoteId);
  const quoteNumber = str(json.quoteNumber);
  const pdfUrl = str(json.pdfUrl);
  // Map current API field names; keep legacy names as fallback for older fixtures/tests.
  const panelCount = num(q.panelsNeeded ?? q.panelCount);
  const cashPrice = num(q.promotionalPrice ?? q.cashPrice);
  const listPrice = num(q.totalSystemCostMxn ?? q.listPrice);
  const annualSavings = num(q.annualSavings);
  const coveragePercent = num(q.actualCoverage ?? q.coveragePercent);
  const paybackYears = num(q.paybackYears);

  const required = {
    quoteId,
    quoteNumber,
    pdfUrl,
    panelCount,
    cashPrice,
    listPrice,
    annualSavings,
    coveragePercent,
    paybackYears,
  };
  for (const [k, v] of Object.entries(required)) {
    if (typeof v === "number" ? !Number.isFinite(v) : !v) {
      return { success: false, error: `response missing field: ${k}` };
    }
  }

  const systemKwRaw = num(q.actualInstalledPowerKw ?? q.systemKw);
  const cfe = (json.cfe ?? undefined) as ParseAndQuoteResult["cfe"];

  return {
    success: true,
    quoteId: quoteId as string,
    quoteNumber: quoteNumber as string,
    pdfUrl: pdfUrl as string,
    quote: {
      panelCount,
      cashPrice,
      listPrice,
      annualSavings,
      coveragePercent,
      paybackYears,
      ...(Number.isFinite(systemKwRaw) ? { systemKw: systemKwRaw } : {}),
    },
    cfe,
  };
}

export function createParseAndQuoteClient(deps: ClientDeps): ParseAndQuoteClient {
  const pollInterval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl(deps.apiUrl);

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

      // Step 1: Submit — expect 202 with requestId
      let submitResponse: Response;
      try {
        submitResponse = await fetch(deps.apiUrl, {
          method: "POST",
          headers: { "X-API-Key": deps.apiKey },
          body: form,
        });
      } catch (err) {
        return { success: false, error: `network error: ${String(err)}` };
      }

      // 4xx errors are synchronous failures
      if (submitResponse.status >= 400 && submitResponse.status < 500) {
        let body = "";
        try {
          body = await submitResponse.text();
        } catch {
          // ignore
        }
        return { success: false, error: `HTTP ${submitResponse.status}: ${body.slice(0, 500)}` };
      }

      if (submitResponse.status !== 202 && !submitResponse.ok) {
        let body = "";
        try {
          body = await submitResponse.text();
        } catch {
          // ignore
        }
        return { success: false, error: `HTTP ${submitResponse.status}: ${body.slice(0, 500)}` };
      }

      let submitJson: Record<string, unknown>;
      try {
        submitJson = (await submitResponse.json()) as Record<string, unknown>;
      } catch (err) {
        return { success: false, error: `invalid JSON from submit: ${String(err)}` };
      }

      const requestId = str(submitJson.requestId);
      if (!requestId) {
        return { success: false, error: "submit response missing requestId" };
      }

      // Step 2: Poll until done/error or timeout.
      // On cache hit (status==="done"), poll immediately to fetch the cached result
      // without waiting a full interval.
      const deadline = Date.now() + timeout;
      const pollUrl = `${base}/check-request/${requestId}`;
      const cacheHit = submitJson.status === "done";

      let firstPoll = true;
      while (Date.now() < deadline) {
        if (!firstPoll || !cacheHit) {
          await sleep(pollInterval);
        }
        firstPoll = false;

        let pollResponse: Response;
        try {
          pollResponse = await fetch(pollUrl, {
            headers: { "X-API-Key": deps.apiKey },
          });
        } catch (err) {
          return { success: false, error: `poll network error: ${String(err)}` };
        }

        if (pollResponse.status === 404) {
          return { success: false, error: `request ${requestId} not found` };
        }

        if (!pollResponse.ok) {
          let body = "";
          try {
            body = await pollResponse.text();
          } catch {
            // ignore
          }
          return {
            success: false,
            error: `poll HTTP ${pollResponse.status}: ${body.slice(0, 500)}`,
          };
        }

        let pollJson: Record<string, unknown>;
        try {
          pollJson = (await pollResponse.json()) as Record<string, unknown>;
        } catch (err) {
          return { success: false, error: `invalid poll JSON: ${String(err)}` };
        }

        const status = pollJson.status as string;

        if (status === "done") {
          const result = (pollJson.result ?? pollJson) as Record<string, unknown>;
          return validateResult(result);
        }

        if (status === "error") {
          const errObj = pollJson.error as Record<string, unknown> | undefined;
          const errMsg = errObj
            ? (str(errObj.message) ?? str(errObj.code) ?? "unknown error")
            : "parse-and-quote failed";
          return { success: false, error: errMsg };
        }

        // queued or processing — continue polling
      }

      return {
        success: false,
        error: `timeout: requestId=${requestId} did not complete in ${timeout}ms`,
      };
    },

    async editQuote(input) {
      if (!input.quoteNumber) {
        return { success: false, error: "quoteNumber is required" };
      }

      const body: Record<string, unknown> = {
        quoteNumber: input.quoteNumber,
        savePdf: true,
      };
      if (typeof input.panels === "number") {
        body.panels = input.panels;
      }
      if (typeof input.totalInvestment === "number") {
        body.totalInvestment = input.totalInvestment;
      }
      if (typeof input.inverterKw === "number") {
        body.inverterKw = input.inverterKw;
      }
      if (typeof input.targetCoverage === "number") {
        body.targetCoverage = input.targetCoverage;
      }
      if (input.clientInfo && Object.keys(input.clientInfo).length > 0) {
        body.clientInfo = input.clientInfo;
      }

      let response: Response;
      try {
        response = await fetch(deps.editQuoteUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": deps.apiKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return { success: false, error: `network error: ${String(err)}` };
      }

      if (!response.ok) {
        let text = "";
        try {
          text = await response.text();
        } catch {
          // ignore
        }
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
      }

      let json: Record<string, unknown>;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch (err) {
        return { success: false, error: `invalid JSON: ${String(err)}` };
      }

      const quoteId = str(json.quoteId);
      const quoteNumber = str(json.quoteNumber);
      const pdfUrl = str(json.pdfUrl);
      const version = num(json.version);
      if (!quoteId || !quoteNumber || !pdfUrl || !Number.isFinite(version)) {
        return {
          success: false,
          error: "edit-quote response missing required fields (quoteId/quoteNumber/pdfUrl/version)",
        };
      }

      const parentQuoteId = str(json.parentQuoteId);
      const results = (json.results ?? json.quote ?? undefined) as
        | Record<string, unknown>
        | undefined;
      let quote: ParseAndQuoteResult["quote"] | undefined;
      if (results) {
        const panelCount = num(results.panelsNeeded ?? results.panelCount);
        const cashPrice = num(results.promotionalPrice ?? results.cashPrice);
        const listPrice = num(results.totalSystemCostMxn ?? results.listPrice);
        const annualSavings = num(results.annualSavings);
        const coveragePercent = num(results.actualCoverage ?? results.coveragePercent);
        const paybackYears = num(results.paybackYears);
        if (
          [panelCount, cashPrice, listPrice, annualSavings, coveragePercent, paybackYears].every(
            (v) => Number.isFinite(v),
          )
        ) {
          const systemKwRaw = num(results.actualInstalledPowerKw ?? results.systemKw);
          quote = {
            panelCount,
            cashPrice,
            listPrice,
            annualSavings,
            coveragePercent,
            paybackYears,
            ...(Number.isFinite(systemKwRaw) ? { systemKw: systemKwRaw } : {}),
          };
        }
      }

      return {
        success: true,
        quoteId,
        quoteNumber,
        version,
        ...(parentQuoteId ? { parentQuoteId } : {}),
        pdfUrl,
        ...(quote ? { quote } : {}),
      };
    },
  };
}
