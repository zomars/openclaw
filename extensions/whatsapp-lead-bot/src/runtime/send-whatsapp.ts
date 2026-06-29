export type WhatsAppSendMessageFn = (
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg?: unknown;
    accountId?: string;
    mediaUrl?: string;
    preserveLeadingWhitespace?: boolean;
  },
) => Promise<unknown>;

export type WebChannelFallbackSendFn = (
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg?: unknown;
    accountId?: string;
  },
) => Promise<unknown>;

export async function sendLeadBotWhatsAppMessage(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string;
  cfg?: unknown;
  dryRunPrefixes?: readonly string[];
  sendMessageWhatsApp?: WhatsAppSendMessageFn;
  fallbackSendWebChannelMessage: WebChannelFallbackSendFn;
}): Promise<void> {
  if (matchesDryRunPrefix(params.to, params.dryRunPrefixes ?? [])) {
    console.log(`[lead-bot] Dry-run delivery skipped for ${params.to}`);
    return;
  }

  if (typeof params.sendMessageWhatsApp === "function") {
    await params.sendMessageWhatsApp(params.to, params.text, {
      verbose: false,
      cfg: params.cfg,
      accountId: params.accountId,
      mediaUrl: params.mediaUrl,
      preserveLeadingWhitespace: true,
    });
    return;
  }

  await params.fallbackSendWebChannelMessage(params.to, params.text, {
    verbose: false,
    cfg: params.cfg,
    accountId: params.accountId,
  });
}

function matchesDryRunPrefix(to: string, prefixes: readonly string[]): boolean {
  const normalizedTo = to.replace(/^\+/, "");
  return prefixes.some((prefix) => {
    const trimmed = prefix.trim();
    if (!trimmed) {
      return false;
    }
    return to.startsWith(trimmed) || normalizedTo.startsWith(trimmed.replace(/^\+/, ""));
  });
}
