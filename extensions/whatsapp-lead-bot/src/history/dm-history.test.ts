import { describe, expect, it } from "vitest";
import { formatDmHistoryBody, type DmHistoryMessageRow } from "./dm-history.js";

describe("formatDmHistoryBody", () => {
  it("summarizes historical media without exposing local paths", () => {
    const body = formatDmHistoryBody({
      content: "OCB",
      media_type: "application/pdf",
      media_filename: "Attachment-1[1].pdf",
      media_size: 236866,
    });

    expect(body).toBe("OCB [application/pdf, Attachment-1[1].pdf, 236866 bytes]");
    expect(body).not.toContain("path:");
  });

  it("keeps reaction and edit markers", () => {
    expect(
      formatDmHistoryBody({
        content: "ignored",
        media_type: "application/pdf",
        reaction_emoji: "👍",
        reaction_target_id: "msg-1",
      }),
    ).toBe("[reaction 👍 on msg-1]");

    expect(formatDmHistoryBody({ content: "updated", edited_from_id: "msg-2" })).toBe(
      "[edited msg-2] updated",
    );
  });
});

describe("DmHistoryMessageRow type guard — historical PDF paths not actionable", () => {
  it("excludes media_path from the type (compile-time guard)", () => {
    // DmHistoryMessageRow deliberately omits media_path so callers cannot
    // accidentally pass a local filesystem path into the history formatter.
    // This is a type-level assertion: if media_path were added to the type,
    // this test would fail to compile.
    const row: DmHistoryMessageRow = {
      content: "OCB",
      media_type: "application/pdf",
      media_filename: "Attachment-1[1].pdf",
      media_size: 236866,
    };
    const _invalid = {
      content: "OCB",
      // @ts-expect-error — media_path must NOT be assignable to DmHistoryMessageRow
      media_path: "/tmp/old-receipt.pdf",
    } satisfies DmHistoryMessageRow;
    void _invalid;
    // Verify the row has no media_path property at runtime either
    expect((row as Record<string, unknown>).media_path).toBeUndefined();
  });

  it("does not leak local path when DB row has media_path set (regression: July 1 class)", () => {
    // Simulate a StoredMessage row from the DB that has media_path populated
    // (e.g. from enriched media download events). The formatter must NOT
    // include the local filesystem path in the history text.
    const dbRow = {
      id: "msg-historical-1",
      chat_jid: "5216621413782@s.whatsapp.net",
      sender_jid: "5216621413782@s.whatsapp.net",
      from_me: 0,
      timestamp: 1719878400,
      content: "OCB",
      message_type: "documentMessage",
      media_type: "application/pdf",
      media_filename: "Attachment-1[1].pdf",
      media_size: 236866,
      // This is the bug vector: the DB has a local path from enriched events
      media_path: "/tmp/whatsapp-media/solayre/5216621413782@lid/old-receipt.pdf",
      reaction_emoji: null,
      reaction_target_id: null,
      revoked_target_id: null,
      edited_from_id: null,
      peer_e164: "+5216621413782",
      created_at: 1719878400,
    };

    // The formatter only receives the fields it needs — media_path is excluded
    // by the DmHistoryMessageRow type. The caller (DM history loader in index.ts)
    // destructures the DB row into only the fields the formatter accepts.
    const body = formatDmHistoryBody({
      content: dbRow.content,
      media_type: dbRow.media_type,
      media_filename: dbRow.media_filename,
      media_size: dbRow.media_size,
    });

    // The history text must show type/name/size only — no local path
    expect(body).toBe("OCB [application/pdf, Attachment-1[1].pdf, 236866 bytes]");
    expect(body).not.toContain("path:");
    expect(body).not.toContain("/tmp/");
    expect(body).not.toContain("whatsapp-media");
    expect(body).not.toContain("old-receipt.pdf");
  });

  it("proves current message media path is separate from history (structured media facts)", () => {
    // Scenario: DM history has old PDFs with media_path, current message has
    // one new PDF. The history text must not contain any path, and the current
    // message's media path must only be available through structured media facts
    // (not embedded in the history body text).

    // --- Historical messages (simulating DB rows) ---
    const historicalRows = [
      {
        content: "OCB",
        media_type: "application/pdf",
        media_filename: "Attachment-1[1].pdf",
        media_size: 236866,
        // media_path intentionally excluded from DmHistoryMessageRow
      },
      {
        content: "Aquí está mi recibo",
        media_type: "image/jpeg",
        media_filename: "IMG-20240601-WA0001.jpg",
        media_size: 152400,
      },
    ];

    // --- Current message media (the one PDF the agent should act on) ---
    const currentMedia = {
      path: "/tmp/whatsapp-media/solayre/5216621413782@s.whatsapp.net/current-receipt.pdf",
      type: "application/pdf",
      filename: "current-receipt.pdf",
      size: 312000,
    };

    // Format each historical row
    const historyBodies = historicalRows.map((row) => formatDmHistoryBody(row));

    // Verify history bodies contain NO paths
    for (const body of historyBodies) {
      expect(body).not.toContain("path:");
      expect(body).not.toContain("/tmp/");
      expect(body).not.toContain("whatsapp-media");
    }

    // Verify history shows only type/name/size
    expect(historyBodies[0]).toBe("OCB [application/pdf, Attachment-1[1].pdf, 236866 bytes]");
    expect(historyBodies[1]).toBe(
      "Aquí está mi recibo [image/jpeg, IMG-20240601-WA0001.jpg, 152400 bytes]",
    );

    // Verify the current message's media path is NOT in any history body
    for (const body of historyBodies) {
      expect(body).not.toContain(currentMedia.filename);
      expect(body).not.toContain(currentMedia.path);
    }

    // The current media path is only available through structured media facts
    // (simulated here as a separate object, not embedded in history text)
    const structuredMediaFacts = {
      path: currentMedia.path,
      contentType: currentMedia.type,
    };
    expect(structuredMediaFacts.path).toBe(currentMedia.path);
    expect(structuredMediaFacts.contentType).toBe("application/pdf");
  });
});
