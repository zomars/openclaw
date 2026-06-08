import { z } from "zod";

const zodSchema = z.object({
  enabled: z.boolean().default(true),
  whatsappAccounts: z.array(z.string()).default(["default"]),
  parseAndQuoteUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/parse-and-quote"),
  editQuoteUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/calculate-quote"),
  searchQuotesUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/search-quotes"),
  sendQuotePdfUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/send-quote-pdf"),
  /** Keep quote processing below common MCP/tool timeouts so failures can alert cleanly. */
  parseAndQuoteTimeoutMs: z.number().int().positive().default(45_000),
  mediaDir: z.string().optional(),
  alertTelegramChatId: z.string().optional(),
  alertTelegramThreadId: z.union([z.string(), z.number()]).optional(),
  alertTelegramAccountId: z.string().optional(),
});

export type SolayreQuotesCoworkerConfig = z.infer<typeof zodSchema>;

export const SolayreQuotesCoworkerConfigSchema = {
  parse(value: unknown): SolayreQuotesCoworkerConfig {
    return zodSchema.parse(value ?? {});
  },
};
