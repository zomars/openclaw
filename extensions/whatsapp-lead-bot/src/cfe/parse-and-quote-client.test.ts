import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createParseAndQuoteClient } from "./parse-and-quote-client.js";

const originalFetch = globalThis.fetch;

function makePdfFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-and-quote-client-"));
  const file = path.join(dir, "receipt.pdf");
  fs.writeFileSync(file, Buffer.from("%PDF-1.4\n% test receipt\n"));
  return file;
}

describe("parse-and-quote-client", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("submits receipts with the parser's multipart files field", async () => {
    const mediaPath = makePdfFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ requestId: "req_123", status: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createParseAndQuoteClient({
      apiKey: "test-key",
      apiUrl: "https://example.supabase.co/functions/v1/parse-and-quote",
      editQuoteUrl: "https://example.supabase.co/functions/v1/calculate-quote",
    });

    await client.submitReceipt({ mediaPath, phoneNumber: "5216671234567" });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect([...form.keys()]).toEqual(["files", "phone_number"]);
    expect(form.get("files")).toBeInstanceOf(File);
    expect(form.get("file")).toBeNull();
  });

  it("uses long polling waitMs when checking async parse-and-quote requests", async () => {
    const mediaPath = makePdfFixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ requestId: "req_123", status: "processing" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            result: {
              quoteId: "quote_123",
              quoteNumber: "SOL20260602-test",
              pdfUrl: "https://example.com/quote.pdf",
              quote: {
                panelCount: 4,
                cashPrice: 100000,
                listPrice: 120000,
                annualSavings: 25000,
                coveragePercent: 95,
                paybackYears: 4.2,
                systemKw: 2.2,
                panelWattage: 550,
                financedPrice: 120000,
                fomo25Years: 500000,
                roi25YearsPercent: 416,
              },
              cfe: {
                data: {
                  serviceNumber: "546900701643",
                  annualConsumption: 9634,
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createParseAndQuoteClient({
      apiKey: "test-key",
      apiUrl: "https://example.supabase.co/functions/v1/parse-and-quote",
      editQuoteUrl: "https://example.supabase.co/functions/v1/calculate-quote",
      longPollWaitMs: 15_000,
    });

    const result = await client.quote({ mediaPath, phoneNumber: "5216671234567" });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pollUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(pollUrl.pathname).toBe("/functions/v1/check-request/req_123");
    expect(pollUrl.searchParams.get("waitMs")).toBe("15000");
  });

  it("derives panel wattage from system size when async result omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "done",
          result: {
            quoteId: "quote_123",
            quoteNumber: "SOL20260602-test",
            pdfUrl: "https://example.com/quote.pdf",
            quote: {
              panelCount: 6,
              cashPrice: 100000,
              listPrice: 120000,
              annualSavings: 25000,
              coveragePercent: 95,
              paybackYears: 4.2,
              systemKw: 3.87,
              financedPrice: 120000,
              fomo25Years: 500000,
              roi25YearsPercent: 416,
            },
            cfe: {
              data: {
                serviceNumber: "546900701643",
                annualConsumption: 9634,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createParseAndQuoteClient({
      apiKey: "test-key",
      apiUrl: "https://example.supabase.co/functions/v1/parse-and-quote",
      editQuoteUrl: "https://example.supabase.co/functions/v1/calculate-quote",
    });

    const result = await client.checkRequest("req_123");

    expect(result.success).toBe(true);
    if (!result.success || result.status !== "done") {
      throw new Error("expected done result");
    }
    expect(result.result.quote.panelWattage).toBe(645);
  });

  it("accepts current API financial and panel field aliases", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "done",
          result: {
            quoteId: "quote_123",
            quoteNumber: "SOL20260602-test",
            pdfUrl: "https://example.com/quote.pdf",
            quote: {
              panelsNeeded: 11,
              promotionalPrice: 115577.55,
              totalSystemCostMxn: 212850,
              annualSavings: 31314.3,
              actualCoverage: 105.86,
              paybackYears: 3.69,
              actualInstalledPowerKw: 7.095,
              selectedPanelWattage: 645,
              twentyFiveYearCostWithoutSolar: 1256361.42,
              roi: 2093.79,
            },
            cfe: {
              data: {
                serviceNumber: "538220809404",
                annualConsumption: 13455,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createParseAndQuoteClient({
      apiKey: "test-key",
      apiUrl: "https://example.supabase.co/functions/v1/parse-and-quote",
      editQuoteUrl: "https://example.supabase.co/functions/v1/calculate-quote",
    });

    const result = await client.checkRequest("req_123");

    expect(result.success).toBe(true);
    if (!result.success || result.status !== "done") {
      throw new Error("expected done result");
    }
    expect(result.result.quote.panelCount).toBe(11);
    expect(result.result.quote.financedPrice).toBe(212850);
    expect(result.result.quote.fomo25Years).toBe(1256361.42);
    expect(result.result.quote.roi25YearsPercent).toBe(2093.79);
  });
});
