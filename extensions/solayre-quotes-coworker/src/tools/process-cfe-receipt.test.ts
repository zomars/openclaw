import { describe, expect, it, vi } from "vitest";
import type { ParseAndQuoteResult } from "../cfe/parse-and-quote-client.js";
import { createDedupCache } from "./dedup-cache.js";
import { processCFEReceiptCoworkerTool } from "./process-cfe-receipt.js";

const quoteResult: ParseAndQuoteResult = {
  success: true,
  quoteId: "quote-1",
  quoteNumber: "SOL-1",
  pdfUrl: "https://example.com/quote.pdf",
  quote: {
    panelCount: 7,
    cashPrice: 73549,
    listPrice: 80000,
    annualSavings: 16400,
    coveragePercent: 96,
    paybackYears: 4.5,
  },
  cfe: {
    data: {
      customerName: "Cliente Prueba",
      tariffType: "1F",
      annualConsumption: 7200,
    },
  },
};

describe("processCFEReceiptCoworkerTool", () => {
  it("delivers the quote to the coworker when no client phone is provided", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);

    const result = await processCFEReceiptCoworkerTool.execute(
      {
        mediaPath: "/tmp/receipt.pdf",
        coworkerPhone: "5216672350818",
      },
      {
        parseAndQuote,
        downloadFile,
        runtime: { sendMessage },
        outputDir: "/tmp/out",
      },
    );

    expect(result).toMatchObject({
      success: true,
      quoteId: "quote-1",
      quoteNumber: "SOL-1",
      pdfPath: "/tmp/out/SOL-1.pdf",
    });
    expect(parseAndQuote).toHaveBeenCalledWith({
      mediaPath: "/tmp/receipt.pdf",
      phoneNumber: "5216672350818",
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "5216672350818",
      expect.objectContaining({ text: expect.stringContaining("Recibí el recibo") }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "5216672350818",
      expect.objectContaining({
        text: expect.stringContaining("Cotización para Cliente Prueba"),
        metadata: expect.objectContaining({
          attachments: [{ path: "/tmp/out/SOL-1.pdf", contentType: "application/pdf" }],
        }),
      }),
    );
  });

  it("returns cached result on repeated invocation with same (phone, mediaPath)", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    // First call — should parse, download, send ack + quote.
    const first = await processCFEReceiptCoworkerTool.execute(
      {
        mediaPath: "/tmp/receipt.pdf",
        coworkerPhone: "5216672350818",
      },
      {
        parseAndQuote,
        downloadFile,
        runtime: { sendMessage },
        outputDir: "/tmp/out",
        dedupCache,
      },
    );

    expect(first.success).toBe(true);
    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Second call with same params — should hit cache, no new API calls or messages.
    const second = await processCFEReceiptCoworkerTool.execute(
      {
        mediaPath: "/tmp/receipt.pdf",
        coworkerPhone: "5216672350818",
      },
      {
        parseAndQuote,
        downloadFile,
        runtime: { sendMessage },
        outputDir: "/tmp/out",
        dedupCache,
      },
    );

    expect(second).toEqual(first);
    expect(parseAndQuote).toHaveBeenCalledTimes(1); // no additional call
    expect(sendMessage).toHaveBeenCalledTimes(2); // no additional messages
  });

  it("does not dedup across different media paths", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt-a.pdf", coworkerPhone: "5216672350818" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt-b.pdf", coworkerPhone: "5216672350818" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4); // 2 acks + 2 quotes
  });

  it("does not dedup across different delivery phones", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt.pdf", coworkerPhone: "5216672350818" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt.pdf", coworkerPhone: "5216672350819" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("expired cache entry allows re-processing", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(10); // 10ms TTL

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt.pdf", coworkerPhone: "5216672350818" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));

    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: "/tmp/receipt.pdf", coworkerPhone: "5216672350818" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("uses default module-level cache when no dedupCache is provided", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);

    // Use a unique phone+media to avoid cross-test cache pollution.
    const uniquePhone = "5216672350999";
    const uniqueMedia = "/tmp/receipt-default-cache.pdf";

    // First call — no explicit cache, uses module-level default.
    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: uniqueMedia, coworkerPhone: uniquePhone },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out" },
    );

    // Second call — same params, should hit the module-level cache.
    await processCFEReceiptCoworkerTool.execute(
      { mediaPath: uniqueMedia, coworkerPhone: uniquePhone },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out" },
    );

    // parseAndQuote should only be called once (second call hits cache).
    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("concurrent invocations for same (phone, mediaPath) share one execution", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    // Launch two concurrent calls for the same key
    const [r1, r2] = await Promise.all([
      processCFEReceiptCoworkerTool.execute(
        { mediaPath: "/tmp/concurrent.pdf", coworkerPhone: "5216672350998" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
      processCFEReceiptCoworkerTool.execute(
        { mediaPath: "/tmp/concurrent.pdf", coworkerPhone: "5216672350998" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
    ]);

    // Both should succeed with the same result
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1).toEqual(r2);

    // parseAndQuote should only be called once
    expect(parseAndQuote).toHaveBeenCalledTimes(1);

    // Only one ack and one quote message should be sent
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("concurrent invocations for different keys execute independently", async () => {
    const parseAndQuote = vi.fn(async (input: { mediaPath: string }) => {
      // Return a result that includes the media path so we can verify
      return {
        ...quoteResult,
        quoteNumber: `SOL-${input.mediaPath === "/tmp/a.pdf" ? "A" : "B"}`,
        pdfUrl: `https://example.com/quote-${input.mediaPath === "/tmp/a.pdf" ? "A" : "B"}.pdf`,
      };
    });
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    const [r1, r2] = await Promise.all([
      processCFEReceiptCoworkerTool.execute(
        { mediaPath: "/tmp/a.pdf", coworkerPhone: "5216672350001" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
      processCFEReceiptCoworkerTool.execute(
        { mediaPath: "/tmp/b.pdf", coworkerPhone: "5216672350002" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.quoteNumber).toBe("SOL-A");
    expect(r2.quoteNumber).toBe("SOL-B");
    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });
});
