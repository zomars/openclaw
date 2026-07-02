import { describe, expect, it, vi } from "vitest";
import type { ParseAndQuoteResult } from "../cfe/parse-and-quote-client.js";
import { createDedupCache } from "./dedup-cache.js";
import { processCFEReceiptLeadsTool } from "./process-cfe-receipt.js";

const quoteResult: ParseAndQuoteResult = {
  success: true,
  quoteId: "quote-lead-1",
  quoteNumber: "SOL-LEAD-1",
  pdfUrl: "https://example.com/quote-lead.pdf",
  quote: {
    panelCount: 10,
    cashPrice: 150000,
    listPrice: 190000,
    annualSavings: 14000,
    coveragePercent: 92,
    paybackYears: 4.8,
  },
  cfe: {
    data: {
      customerName: "Cliente Lead",
      tariffType: "1F",
      annualConsumption: 9634,
    },
  },
};

describe("processCFEReceiptLeadsTool", () => {
  it("delivers the quote to the lead", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);

    const result = await processCFEReceiptLeadsTool.execute(
      {
        mediaPath: "/tmp/lead-receipt.pdf",
        leadPhone: "526671234567",
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
      quoteId: "quote-lead-1",
      quoteNumber: "SOL-LEAD-1",
      pdfPath: "/tmp/out/SOL-LEAD-1.pdf",
    });
    expect(parseAndQuote).toHaveBeenCalledWith({
      mediaPath: "/tmp/lead-receipt.pdf",
      phoneNumber: "526671234567",
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "526671234567",
      expect.objectContaining({ text: expect.stringContaining("Recibí su recibo") }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "526671234567",
      expect.objectContaining({
        text: expect.stringContaining("Cotización para Cliente Lead"),
        metadata: expect.objectContaining({
          attachments: [{ path: "/tmp/out/SOL-LEAD-1.pdf", contentType: "application/pdf" }],
        }),
      }),
    );
  });

  it("returns cached result on repeated invocation with same (leadPhone, mediaPath)", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    const first = await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(first.success).toBe(true);
    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const second = await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(second).toEqual(first);
    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dedup across different media paths", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt-a.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt-b.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("does not dedup across different lead phones", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234568" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("expired cache entry allows re-processing", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(10);

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    await new Promise((r) => setTimeout(r, 20));

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: "/tmp/lead-receipt.pdf", leadPhone: "526671234567" },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out", dedupCache },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });

  it("uses default module-level cache when no dedupCache is provided", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);

    const uniquePhone = "526671234999";
    const uniqueMedia = "/tmp/lead-receipt-default.pdf";

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: uniqueMedia, leadPhone: uniquePhone },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out" },
    );

    await processCFEReceiptLeadsTool.execute(
      { mediaPath: uniqueMedia, leadPhone: uniquePhone },
      { parseAndQuote, downloadFile, runtime: { sendMessage }, outputDir: "/tmp/out" },
    );

    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("concurrent invocations for same (leadPhone, mediaPath) share one execution", async () => {
    const parseAndQuote = vi.fn(async () => quoteResult);
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    const [r1, r2] = await Promise.all([
      processCFEReceiptLeadsTool.execute(
        { mediaPath: "/tmp/concurrent-lead.pdf", leadPhone: "526671234001" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
      processCFEReceiptLeadsTool.execute(
        { mediaPath: "/tmp/concurrent-lead.pdf", leadPhone: "526671234001" },
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
    expect(r1).toEqual(r2);
    expect(parseAndQuote).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("concurrent invocations for different keys execute independently", async () => {
    const parseAndQuote = vi.fn(async (input: { mediaPath: string }) => {
      return {
        ...quoteResult,
        quoteNumber: `SOL-${input.mediaPath === "/tmp/lead-a.pdf" ? "A" : "B"}`,
        pdfUrl: `https://example.com/quote-${input.mediaPath === "/tmp/lead-a.pdf" ? "A" : "B"}.pdf`,
      };
    });
    const downloadFile = vi.fn(async (_url: string, destPath: string) => destPath);
    const sendMessage = vi.fn(async () => undefined);
    const dedupCache = createDedupCache(60_000);

    const [r1, r2] = await Promise.all([
      processCFEReceiptLeadsTool.execute(
        { mediaPath: "/tmp/lead-a.pdf", leadPhone: "526671234001" },
        {
          parseAndQuote,
          downloadFile,
          runtime: { sendMessage },
          outputDir: "/tmp/out",
          dedupCache,
        },
      ),
      processCFEReceiptLeadsTool.execute(
        { mediaPath: "/tmp/lead-b.pdf", leadPhone: "526671234002" },
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
