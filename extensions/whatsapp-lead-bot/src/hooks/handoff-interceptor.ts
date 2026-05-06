/**
 * Handoff interceptor — silently captures media (especially CFE receipts)
 * and logs text messages when a lead is in handed_off status.
 * No response is ever sent to the lead.
 */

import type { Lead } from "../database/schema.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { PluginHookMessageReceivedEvent, PluginHookMessageReceivedResult } from "../types.js";

export interface HandoffInterceptorDeps {
  agentNotifier: AgentNotifier;
}

interface HandoffInput {
  event: PluginHookMessageReceivedEvent;
  lead: Lead;
}

export class HandoffInterceptor {
  constructor(private deps: HandoffInterceptorDeps) {}

  async handle(input: HandoffInput): Promise<PluginHookMessageReceivedResult | null> {
    const { lead, event } = input;
    if (lead.status !== "handed_off") {
      return null;
    }

    const { mediaType, mediaPath } = this.extractMedia(event);

    if (mediaType && this.isPotentialReceipt(mediaType)) {
      // Receipts received post-handoff: notify the human agent for review;
      // we no longer parse server-side here.
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "receipt");
      void mediaPath;
    } else if (mediaType) {
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "media");
    }
    // Text messages: already stored via raw message listener, no notification needed

    return { suppress: true };
  }

  private extractMedia(event: PluginHookMessageReceivedEvent): {
    mediaType?: string;
    mediaPath?: string;
  } {
    let mediaType = (event.metadata?.MediaType || event.metadata?.mediaType) as string | undefined;
    let mediaPath = event.metadata?.mediaPath as string | undefined;

    if (!mediaType && event.content.includes("[media attached:")) {
      const match = event.content.match(/\[media attached: (.+?) \((.+?)\)\]/);
      if (match) {
        mediaPath = match[1];
        mediaType = match[2];
      }
    }

    if (mediaType === "text/plain") {
      mediaType = undefined;
    }
    return { mediaType, mediaPath };
  }

  private isPotentialReceipt(mediaType: string): boolean {
    return (
      mediaType === "application/pdf" ||
      mediaType === "image/jpeg" ||
      mediaType === "image/png" ||
      mediaType === "image/webp"
    );
  }
}
