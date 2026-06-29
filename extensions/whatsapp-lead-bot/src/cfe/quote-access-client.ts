export interface QuoteAccessTokenResult {
  tokenId: string;
  url: string;
  expiresAt: number;
}

export interface QuoteAccessTokenClient {
  createQuoteToken(input: {
    quoteNumber: string;
    version?: number;
  }): Promise<QuoteAccessTokenResult>;
}

export interface QuoteAccessTokenClientDeps {
  apiKey: string;
  tokenUrl: string;
  publicBaseUrl: string;
  expiresInDays?: number;
  source?: string;
}

function millis(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function absolutePublicUrl(base: string, pathOrUrl: string): string {
  return new URL(pathOrUrl, base.endsWith("/") ? base : `${base}/`).toString();
}

export function createQuoteAccessTokenClient(
  deps: QuoteAccessTokenClientDeps,
): QuoteAccessTokenClient {
  return {
    async createQuoteToken(input) {
      const response = await fetch(deps.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": deps.apiKey,
        },
        body: JSON.stringify({
          quote_number: input.quoteNumber,
          ...(input.version ? { version: input.version } : {}),
          expires_in_days: deps.expiresInDays ?? 30,
          supersede: true,
          source: deps.source ?? "openclaw_shadow",
        }),
      });

      if (!response.ok) {
        throw new Error(`create-quote-token HTTP ${response.status}: ${await response.text()}`);
      }

      const json = (await response.json()) as Record<string, unknown>;
      const tokenId = typeof json.token_id === "string" ? json.token_id : undefined;
      const url = typeof json.url === "string" ? json.url : undefined;
      const expiresAt = millis(json.expires_at);

      if (!tokenId || !url || !Number.isFinite(expiresAt)) {
        throw new Error("create-quote-token response missing token_id/url/expires_at");
      }

      return {
        tokenId,
        url: absolutePublicUrl(deps.publicBaseUrl, url),
        expiresAt,
      };
    },
  };
}
