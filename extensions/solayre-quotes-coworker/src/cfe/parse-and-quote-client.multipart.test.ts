import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createParseAndQuoteClient } from "./parse-and-quote-client.js";

describe("createParseAndQuoteClient multipart contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits receipts with the parser's multipart files field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "solayre-quote-client-"));
    const mediaPath = join(dir, "receipt.pdf");
    writeFileSync(mediaPath, Buffer.from("%PDF-1.4\n% test receipt\n"));

    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/check-request/")) {
        return new Response(
          JSON.stringify({
            requestId: "req-1",
            status: "error",
            error: { code: "STOP", message: "stop after submit" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ requestId: "req-1", status: "queued" }), {
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetch);

    const client = createParseAndQuoteClient({
      apiKey: "test-key",
      apiUrl: "https://example.com/functions/v1/parse-and-quote",
      editQuoteUrl: "https://example.com/functions/v1/calculate-quote",
      searchQuotesUrl: "https://example.com/functions/v1/search-quotes",
      sendQuotePdfUrl: "https://example.com/functions/v1/send-quote-pdf",
      pollIntervalMs: 0,
    });

    await client.quote({ mediaPath, phoneNumber: "5216672350818" });

    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect([...form.keys()]).toEqual(["files", "phone_number"]);
    expect(form.get("files")).toBeInstanceOf(File);
    expect(form.get("file")).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});
