import { z } from "zod";

const zodSchema = z.object({
  enabled: z.boolean().default(true),

  // WhatsApp account filtering
  whatsappAccounts: z.array(z.string()).default(["default"]),

  // Agent notification settings (handoff/lead notifications)
  agentNumbers: z.array(z.string()).default([]),

  // Team members who bypass lead pipeline (coworker mode, no notifications)
  teamNumbers: z.array(z.string()).default([]),

  // Phone prefixes for eval/dry-run mode — messages to matching numbers skip WhatsApp delivery
  // while still running through the full plugin pipeline (hooks, lead DB, etc.)
  dryRunPrefixes: z.array(z.string()).default([]),

  // Agent identity (for session key construction)
  agentId: z.string().optional(),

  // Database
  dbPath: z.string().optional(),

  // Rate limiting
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      messagesPerHour: z.number().default(10),
      windowMs: z.number().default(3600000), // 1 hour
      notifyOnLimit: z.boolean().default(true),

      // Global rate limit (system-wide across all leads)
      global: z
        .object({
          enabled: z.boolean().default(true),
          maxMessagesPerHour: z.number().default(1000),
          windowMs: z.number().default(3600000), // 1 hour
        })
        .default({
          enabled: true,
          maxMessagesPerHour: 1000,
          windowMs: 3600000,
        }),

      // Circuit breaker (emergency stop)
      circuitBreaker: z
        .object({
          enabled: z.boolean().default(true),
          hitRateThreshold: z.number().min(0).max(1).default(0.8),
          windowMs: z.number().default(300000), // 5 minutes
          minChecks: z.number().default(10),
        })
        .default({
          enabled: true,
          hitRateThreshold: 0.8,
          windowMs: 300000,
          minChecks: 10,
        }),
    })
    .default({
      enabled: true,
      messagesPerHour: 10,
      windowMs: 3600000,
      notifyOnLimit: true,
      global: {
        enabled: true,
        maxMessagesPerHour: 1000,
        windowMs: 3600000,
      },
      circuitBreaker: {
        enabled: true,
        hitRateThreshold: 0.8,
        windowMs: 300000,
        minChecks: 10,
      },
    }),

  // Follow-up
  followup: z
    .object({
      enabled: z.boolean().default(true),
      silenceThresholdHours: z.number().default(24),
      maxFollowups: z.number().default(1),
      checkIntervalMinutes: z.number().default(15),
    })
    .default({
      enabled: true,
      silenceThresholdHours: 24,
      maxFollowups: 1,
      checkIntervalMinutes: 15,
    }),

  // Qualification
  qualificationPrompt: z.string().optional(),
  autoHandoffWhenQualified: z.boolean().default(false),

  // Notifications
  notifyNewLeads: z.boolean().default(true),
  notifyQualified: z.boolean().default(true),
  notifyHandoff: z.boolean().default(true),

  // WhatsApp label names for score and status tagging (resolved to IDs via DB + runtime)
  labels: z
    .object({
      scores: z
        .object({
          HOT: z.string().default("HOT"),
          WARM: z.string().default("WARM"),
          COLD: z.string().default("COLD"),
          OUT: z.string().default("OUT"),
        })
        .default({ HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" }),
      statuses: z
        .object({
          BOT: z.string().default("BOT"),
          HUMANO: z.string().default("HUMANO"),
        })
        .default({ BOT: "BOT", HUMANO: "HUMANO" }),
      tags: z
        .object({
          FUERA_DE_AREA: z.string().default("Fuera de área"),
        })
        .default({ FUERA_DE_AREA: "Fuera de área" }),
    })
    .default({
      scores: { HOT: "HOT", WARM: "WARM", COLD: "COLD", OUT: "OUT" },
      statuses: { BOT: "BOT", HUMANO: "HUMANO" },
      tags: { FUERA_DE_AREA: "Fuera de área" },
    }),

  // Consolidated parse-and-quote Supabase edge function URL.
  // API key is read from CFE_PARSER_API_KEY env var (no config override).
  parseAndQuoteUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/parse-and-quote"),

  // Synchronous quote-revision endpoint. Produces an incremented version of an
  // existing quote (panels, totalInvestment, targetCoverage, clientInfo, ...).
  editQuoteUrl: z
    .string()
    .url()
    .default("https://itdpiofbltvdumbznyyj.supabase.co/functions/v1/calculate-quote"),
});

export type WhatsAppLeadBotConfig = z.infer<typeof zodSchema>;

export const WhatsAppLeadBotConfigSchema = {
  parse(value: unknown): WhatsAppLeadBotConfig {
    // Handle undefined or null by providing empty object
    const input = value ?? {};
    return zodSchema.parse(input);
  },
};
