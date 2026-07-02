/**
 * Media handler - processes media uploads
 *
 * For CFE receipts: calls the CFE API directly and returns parsed JSON
 * as content rewrite so the agent sees structured data instead of raw PDF.
 *
 * Ack text is returned separately via getAckText() so the caller can
 * send it to the user before the (potentially slow) parsing starts.
 */

import type { Lead } from "../database/schema.js";

export interface MediaHandlerDeps {
  // Reserved for future per-handler config; CFE parsing is now handled by
  // process_cfe_receipt(_customer) tools which the agent invokes directly.
}

const RECEIPT_ACK =
  "Gracias por enviar su recibo. Permítame revisarlo para prepararle su cotización.";

export class MediaHandler {
  constructor(private deps: MediaHandlerDeps = {}) {}

  /**
   * Returns the acknowledgment text to send immediately (no I/O).
   * Call this before handleMedia() so the user gets instant feedback.
   */
  getAckText(lead: Lead, mediaType: string): { text: string; suppress: boolean } {
    if (this.isPotentialReceipt(mediaType) && this.isExpectingReceipt(lead)) {
      return { text: RECEIPT_ACK, suppress: false };
    }

    const typeMap: Record<string, string> = {
      image: "la foto",
      video: "el video",
      audio: "el audio",
      document: "el documento",
    };
    const mediaTypeSimple =
      mediaType === "application/pdf"
        ? "document"
        : Object.keys(typeMap).find((key) => mediaType.includes(key)) || "file";
    const mediaLabel = typeMap[mediaTypeSimple] || "el archivo";

    return {
      text: `Gracias por enviar ${mediaLabel}. El equipo lo revisará en breve.`,
      suppress: true,
    };
  }

  /**
   * Processes media. CFE receipts are handled by the agent via the
   * process_cfe_receipt(_customer) tool — this method only decides whether
   * to suppress the agent for non-receipt media (already acked).
   */
  async handleMedia(
    lead: Lead,
    mediaType: string,
    _mediaPath?: string,
    _fileSize?: number,
  ): Promise<{
    suppress: boolean;
    content?: string;
  }> {
    if (this.isPotentialReceipt(mediaType) && this.isExpectingReceipt(lead)) {
      // Let agent invoke process_cfe_receipt(_customer) tool directly.
      return { suppress: false };
    }

    // Non-receipt media — already acked with suppress: true
    return { suppress: true };
  }

  private isPotentialReceipt(mediaType: string): boolean {
    return (
      mediaType === "application/pdf" ||
      mediaType === "image/jpeg" ||
      mediaType === "image/png" ||
      mediaType === "image/webp"
    );
  }

  private isExpectingReceipt(lead: Lead): boolean {
    return !!(lead.name && lead.location && lead.status !== "handed_off");
  }
}
