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
  mediaDir: z.string().optional(),
});

export type SolayreQuotesLeadsConfig = z.infer<typeof zodSchema>;

export const SolayreQuotesLeadsConfigSchema = {
  parse(value: unknown): SolayreQuotesLeadsConfig {
    return zodSchema.parse(value ?? {});
  },
};
