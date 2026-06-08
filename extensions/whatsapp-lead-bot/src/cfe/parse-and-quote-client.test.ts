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
});
