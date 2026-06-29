import type { CrmSyncWorker } from "../crm-sync/worker.js";

export const crmSyncBackfillTool = {
  name: "crm_sync_backfill",
  description:
    "Queue existing local WhatsApp leads for recurrent CRM sync to the Lovable dashboard.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number" as const,
        description: "Optional maximum number of existing leads to enqueue.",
      },
      pushNow: {
        type: "boolean" as const,
        description: "Run one push pass immediately after enqueueing.",
      },
    },
    required: [] as string[],
  },
  execute: async (
    params: { limit?: number; pushNow?: boolean },
    context: { crmSyncWorker: CrmSyncWorker | null },
  ) => {
    if (!context.crmSyncWorker) {
      return { success: false, error: "CRM sync worker is not configured" };
    }
    const queued = await context.crmSyncWorker.backfillLeads(params.limit);
    if (params.pushNow) {
      await context.crmSyncWorker.pushOnce();
    }
    return { success: true, queued };
  },
};
