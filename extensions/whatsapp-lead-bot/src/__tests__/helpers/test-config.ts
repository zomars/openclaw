import { WhatsAppLeadBotConfigSchema, type WhatsAppLeadBotConfig } from "../../config/schema.js";

export function createTestConfig(
  overrides?: Partial<WhatsAppLeadBotConfig>,
): WhatsAppLeadBotConfig {
  return WhatsAppLeadBotConfigSchema.parse({
    enabled: true,
    whatsappAccounts: ["default"],
    agentNumbers: ["+15559999999"],
    rateLimit: {
      enabled: true,
      messagesPerHour: 5,
      windowMs: 3600000,
      notifyOnLimit: true,
      global: { enabled: true, maxMessagesPerHour: 100, windowMs: 3600000 },
      circuitBreaker: { enabled: true, hitRateThreshold: 0.8, windowMs: 300000, minChecks: 5 },
    },
    notifyNewLeads: true,
    notifyQualified: true,
    notifyHandoff: true,
    ...overrides,
  });
}
