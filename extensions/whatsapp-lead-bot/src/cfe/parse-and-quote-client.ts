/**
 * Parse-and-Quote API Client
 *
 * Async flow: POST /parse-and-quote → 202 + requestId → long-poll GET /check-request/{id}?waitMs=N
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
    systemKw: number;
    panelWattage: number;
    financedPrice: number;
    fomo25Years: number;
    roi25YearsPercent: number;
  };
  cfe: {
    data: {
      customerName?: string;
      serviceNumber: string;
      tariffType?: string;
      annualConsumption: number;
    };
  };
}

export interface ParseAndQuoteError {
  success: false;
  error: string;
}

export interface SubmitQuoteReceiptResult {
  success: true;
  requestId: string;
}

export type QuoteRequestCheckResult =
  | { success: true; status: "queued" | "processing" }
  | { success: true; status: "done"; result: ParseAndQuoteResult };

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
  submitReceipt(input: {
    mediaPath: string;
    phoneNumber: string;
  }): Promise<SubmitQuoteReceiptResult | ParseAndQuoteError>;
  checkRequest(
    requestId: string,
    options?: { waitMs?: number },
  ): Promise<QuoteRequestCheckResult | ParseAndQuoteError>;
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
  /** Backoff interval in ms for non-terminal immediate responses (default 2500). */
  pollIntervalMs?: number;
  /** Per-request long-poll wait in ms (default 25000, server clamps to 30000). */
  longPollWaitMs?: number;
  /** Total timeout in ms (default 120000) */
  timeoutMs?: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_LONG_POLL_WAIT_MS = 25_000;
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
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function derivePanelWattage(input: { panelCount: number; systemKw: number }): number {
  if (!Number.isFinite(input.panelCount) || input.panelCount <= 0) {
    return Number.NaN;
  }
  if (!Number.isFinite(input.systemKw) || input.systemKw <= 0) {
    return Number.NaN;
  }
  return Math.round((input.systemKw * 1000) / input.panelCount);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function baseUrl(apiUrl: string): string {
  // apiUrl points to /parse-and-quote — derive base for /check-request
  const url = new URL(apiUrl);
  url.pathname = url.pathname.replace(/\/parse-and-quote\/?$/, "");
  return url.toString().replace(/\/$/, "");
}

function buildReceiptForm(input: {
  mediaPath: string;
  phoneNumber: string;
}): { success: true; form: FormData } | ParseAndQuoteError {
  if (!input.mediaPath || !input.phoneNumber) {
    return { success: false, error: "mediaPath and phoneNumber are required" };
  }
  if (!fs.existsSync(input.mediaPath)) {
    return { success: false, error: `File not found: ${input.mediaPath}` };
  }
  const stats = fs.statSync(input.mediaPath);
  if (stats.size > MAX_FILE_BYTES) {
    return { success: false, error: `File too large: ${stats.size} bytes (max 10MB)` };
  }
  const buffer = fs.readFileSync(input.mediaPath);
  const detected = detectFileType(buffer);
  if (!detected) {
    return { success: false, error: `Unsupported file type: ${input.mediaPath}` };
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: detected.mime });
  form.append("files", blob, `receipt.${detected.ext}`);
  form.append("phone_number", input.phoneNumber);
  return { success: true, form };
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

  const systemKw = num(q.actualInstalledPowerKw ?? q.installedPowerKw ?? q.systemKw);
  const explicitPanelWattage = num(
    q.panelWattage ??
      q.panelWatts ??
      q.panelPowerW ??
      q.panelPowerWatts ??
      q.moduleWattage ??
      q.selectedPanelWattage ??
      q.wattage,
  );
  const panelWattage = Number.isFinite(explicitPanelWattage)
    ? explicitPanelWattage
    : derivePanelWattage({ panelCount, systemKw });
  const financedPrice = num(
    q.financedPrice ??
      q.financingPrice ??
      q.financedTotal ??
      q.totalFinancedPrice ??
      q.creditPrice ??
      q.totalSystemCostMxn ??
      q.listPrice,
  );
  const fomo25Years = num(
    q.fomo25Years ??
      q.twentyFiveYearCfeCost ??
      q.twentyFiveYearCostWithoutSolar ??
      q.cfeCost25Years ??
      q.projectedCfeCost25Years,
  );
  const roi25YearsPercent = num(
    q.roi25YearsPercent ??
      q.twentyFiveYearRoiPercent ??
      q.roiPercent25Years ??
      q.roi ??
      q.return25YearsPercent,
  );

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
    systemKw,
    panelWattage,
    financedPrice,
    fomo25Years,
    roi25YearsPercent,
  };
  for (const [k, v] of Object.entries(required)) {
    if (typeof v === "number" ? !Number.isFinite(v) : !v) {
      console.error(
        `[parse-and-quote-client] response missing field: ${k}. Raw JSON:`,
        JSON.stringify(json),
      );
      return { success: false, error: `response missing field: ${k}` };
    }
  }

  const cfeRaw = (json.cfe ?? {}) as Record<string, unknown>;
  const cfeData = (cfeRaw.data ?? {}) as Record<string, unknown>;
  const serviceNumber = str(cfeData.serviceNumber);
  const annualConsumption = num(cfeData.annualConsumption);
  if (!serviceNumber || !Number.isFinite(annualConsumption)) {
    console.error(
      "[parse-and-quote-client] response missing required CFE fields. Raw JSON:",
      JSON.stringify(json),
    );
    return {
      success: false,
      error: "response missing required CFE fields: serviceNumber/annualConsumption",
    };
  }
  const cfe: ParseAndQuoteResult["cfe"] = {
    data: {
      ...(str(cfeData.customerName) ? { customerName: str(cfeData.customerName) } : {}),
      serviceNumber,
      ...(str(cfeData.tariffType) ? { tariffType: str(cfeData.tariffType) } : {}),
      annualConsumption,
    },
  };

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
      systemKw,
      panelWattage,
      financedPrice,
      fomo25Years,
      roi25YearsPercent,
    },
    cfe,
  };
}

export function createParseAndQuoteClient(deps: ClientDeps): ParseAndQuoteClient {
  const pollInterval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const longPollWaitMs = deps.longPollWaitMs ?? DEFAULT_LONG_POLL_WAIT_MS;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = baseUrl(deps.apiUrl);

  return {
    async submitReceipt(input) {
      const built = buildReceiptForm(input);
      if (!built.success) {
        return built;
      }

      let submitResponse: Response;
      try {
        submitResponse = await fetch(deps.apiUrl, {
          method: "POST",
          headers: { "X-API-Key": deps.apiKey },
          body: built.form,
        });
      } catch (err) {
        return { success: false, error: `network error: ${String(err)}` };
      }

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

      return { success: true, requestId };
    },

    async checkRequest(requestId, options) {
      if (!requestId) {
        return { success: false, error: "requestId is required" };
      }

      const pollUrl = new URL(`${base}/check-request/${requestId}`);
      const waitMs = options?.waitMs ?? 0;
      if (waitMs > 0) {
        pollUrl.searchParams.set("waitMs", String(waitMs));
      }

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
        const validated = validateResult(result);
        if (!validated.success) {
          return validated;
        }
        return { success: true, status: "done", result: validated };
      }

      if (status === "error") {
        const errObj = pollJson.error as Record<string, unknown> | undefined;
        const errCode = str(errObj?.code) ?? "unknown_error";
        const errDetail = str(errObj?.error) ?? str(errObj?.message) ?? "";
        let errMsg = errDetail ? errCode + ": " + errDetail : errCode;
        if (!errObj) errMsg = "parse-and-quote failed";
        return { success: false, error: errMsg };
      }

      if (status === "queued" || status === "processing") {
        return { success: true, status };
      }

      return { success: false, error: `unknown request status: ${status || "(empty)"}` };
    },

    async quote({ mediaPath, phoneNumber }) {
      const submitted = await this.submitReceipt({ mediaPath, phoneNumber });
      if (!submitted.success) {
        return submitted;
      }

      // Long-poll until done/error or timeout.
      // On cache hit (status==="done"), request immediate status to fetch the cached result.
      // If an older server ignores waitMs and returns queued/processing immediately, back off
      // with pollInterval to avoid tight client-side polling.
      const deadline = Date.now() + timeout;
      let immediateFirstPoll = false;

      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        const waitMs = immediateFirstPoll ? 0 : Math.max(0, Math.min(longPollWaitMs, remainingMs));
        immediateFirstPoll = false;

        const pollStartedAt = Date.now();
        const checked = await this.checkRequest(submitted.requestId, { waitMs });
        if (!checked.success) {
          return checked;
        }
        if (checked.status === "done") {
          return checked.result;
        }

        // queued or processing — continue polling. If the response came back quickly,
        // the server may be old or the wait window may have been tiny; back off locally.
        const elapsedMs = Date.now() - pollStartedAt;
        if (elapsedMs < Math.min(1000, waitMs) && Date.now() + pollInterval < deadline) {
          await sleep(pollInterval);
        }
      }

      return {
        success: false,
        error: `timeout: requestId=${submitted.requestId} did not complete in ${timeout}ms`,
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
        const systemKw = num(
          results.actualInstalledPowerKw ?? results.installedPowerKw ?? results.systemKw,
        );
        const panelWattage = num(
          results.panelWattage ??
            results.panelWatts ??
            results.panelPowerW ??
            results.panelPowerWatts ??
            results.moduleWattage ??
            results.wattage,
        );
        const financedPrice = num(
          results.financedPrice ??
            results.financingPrice ??
            results.financedTotal ??
            results.totalFinancedPrice ??
            results.creditPrice,
        );
        const fomo25Years = num(
          results.fomo25Years ??
            results.twentyFiveYearCfeCost ??
            results.cfeCost25Years ??
            results.projectedCfeCost25Years,
        );
        const roi25YearsPercent = num(
          results.roi25YearsPercent ??
            results.twentyFiveYearRoiPercent ??
            results.roiPercent25Years ??
            results.return25YearsPercent,
        );
        if (
          [
            panelCount,
            cashPrice,
            listPrice,
            annualSavings,
            coveragePercent,
            paybackYears,
            systemKw,
            panelWattage,
            financedPrice,
            fomo25Years,
            roi25YearsPercent,
          ].every((v) => Number.isFinite(v))
        ) {
          quote = {
            panelCount,
            cashPrice,
            listPrice,
            annualSavings,
            coveragePercent,
            paybackYears,
            systemKw,
            panelWattage,
            financedPrice,
            fomo25Years,
            roi25YearsPercent,
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
