import type { CrmSyncStore, Database, LeadRepository } from "../database.js";
import type { CrmSyncOutboxRow, LeadStatus } from "../database/schema.js";
import { normalizePhone } from "../utils/phone.js";
import {
  buildLeadSnapshotPayload,
  type LovableCrmClient,
  type RemoteLovableLead,
} from "./lovable-client.js";

type PushStore = CrmSyncStore &
  LeadRepository & {
    getLatestMessageByPeerE164Sync(peerE164: string): {
      id: string;
      content: string | null;
      from_me: number;
    } | null;
  };

export interface CrmSyncWorkerOptions {
  pushIntervalMs?: number;
  pullIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  pushEnabled?: boolean;
  pullEnabled?: boolean;
  now?: () => number;
}

export interface CrmSyncWorkerDeps {
  store: Database;
  client: LovableCrmClient;
}

const DEFAULT_PUSH_INTERVAL_MS = 60_000;
const DEFAULT_PULL_INTERVAL_MS = 120_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 12;
const PULL_CHECKPOINT = "lovable:list-leads";

export class CrmSyncWorker {
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private pushing = false;
  private pulling = false;
  private readonly pushIntervalMs: number;
  private readonly pullIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly pushEnabled: boolean;
  private readonly pullEnabled: boolean;
  private readonly now: () => number;

  constructor(
    private readonly deps: CrmSyncWorkerDeps,
    options: CrmSyncWorkerOptions = {},
  ) {
    this.pushIntervalMs = options.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
    this.pullIntervalMs = options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.pushEnabled = options.pushEnabled ?? true;
    this.pullEnabled = options.pullEnabled ?? false;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.pushEnabled && !this.pushTimer) {
      void this.pushOnce();
      this.pushTimer = setInterval(() => void this.pushOnce(), this.pushIntervalMs);
    }
    if (this.pullEnabled && !this.pullTimer) {
      void this.pullOnce();
      this.pullTimer = setInterval(() => void this.pullOnce(), this.pullIntervalMs);
    }
  }

  stop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }

  wake(): void {
    if (this.pushEnabled) {
      void this.pushOnce();
    }
  }

  async backfillLeads(limit?: number): Promise<number> {
    const leads = await this.deps.store.listLeads();
    const selected = typeof limit === "number" ? leads.slice(0, limit) : leads;
    for (const lead of selected) {
      await this.deps.store.enqueueLeadSnapshotSync(lead.id);
    }
    return selected.length;
  }

  async pushOnce(): Promise<void> {
    if (!this.pushEnabled || this.pushing) {
      return;
    }
    this.pushing = true;
    try {
      const rows = await this.deps.store.getDueCrmSyncOutbox(this.now(), this.batchSize);
      for (const row of rows) {
        await this.pushRow(row);
      }
    } catch (err) {
      console.error("[crm-sync-worker] push failed:", err);
    } finally {
      this.pushing = false;
    }
  }

  async pullOnce(): Promise<void> {
    if (!this.pullEnabled || this.pulling) {
      return;
    }
    this.pulling = true;
    try {
      const checkpoint = await this.deps.store.getCrmSyncCheckpoint(PULL_CHECKPOINT);
      const remote = await this.deps.client.listLeads({
        cursor: checkpoint?.cursor ?? null,
        updatedAfter: checkpoint?.cursor ? null : new Date(0).toISOString(),
        limit: this.batchSize,
      });
      for (const lead of remote.leads) {
        await this.applyRemoteLead(lead);
      }
      if (remote.next_cursor) {
        await this.deps.store.setCrmSyncCheckpoint(PULL_CHECKPOINT, remote.next_cursor);
      }
    } catch (err) {
      console.error("[crm-sync-worker] pull failed:", err);
    } finally {
      this.pulling = false;
    }
  }

  private async pushRow(row: CrmSyncOutboxRow): Promise<void> {
    const attempts = row.attempts + 1;
    try {
      if (row.event_type !== "lead_snapshot_changed" || row.aggregate_type !== "lead") {
        await this.deps.store.markCrmSyncOutboxSynced(row.id);
        return;
      }

      const leadId = Number(row.aggregate_id);
      const lead = await this.deps.store.getLeadById(leadId);
      if (!lead) {
        await this.deps.store.markCrmSyncOutboxSynced(row.id);
        return;
      }

      const peerE164 = toE164(lead.phone_number);
      const lastMessage = peerE164
        ? (this.deps.store as PushStore).getLatestMessageByPeerE164Sync(peerE164)
        : null;
      await this.deps.client.saveLead(buildLeadSnapshotPayload(lead, lastMessage));
      await this.deps.store.markCrmSyncOutboxSynced(row.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempts >= this.maxAttempts) {
        await this.deps.store.markCrmSyncOutboxFailed(row.id, { attempts, error });
        return;
      }
      await this.deps.store.rescheduleCrmSyncOutbox(row.id, {
        attempts,
        nextAttemptAt: this.now() + backoffMs(attempts),
        lastError: error,
      });
    }
  }

  private async applyRemoteLead(remote: RemoteLovableLead): Promise<void> {
    const local = await this.deps.store.getLeadByPhone(remote.phone_number);
    if (!local) {
      return;
    }

    if (isAllowedRemoteStatus(remote.status) && remote.status !== local.status) {
      await this.deps.store.updateLeadStatus(local.id, remote.status);
      await this.deps.store.logHandoffEvent(local.id, "crm_status_changed", "lovable_dashboard", {
        remoteLeadId: remote.id,
        from: local.status,
        to: remote.status,
      });
    }

    if ((remote.assigned_to_phone ?? null) !== (local.assigned_agent ?? null)) {
      await this.deps.store.updateAssignedAgent(local.id, remote.assigned_to_phone ?? null);
      await this.deps.store.logHandoffEvent(local.id, "crm_owner_changed", "lovable_dashboard", {
        remoteLeadId: remote.id,
        assignedToPhone: remote.assigned_to_phone ?? null,
      });
    }

    if (remote.handoff_reason) {
      await this.deps.store.updateCustomFields(local.id, {
        lovable_handoff_reason: remote.handoff_reason,
        lovable_handoff_reason_synced_at: this.now(),
      });
    }
  }
}

function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

function isAllowedRemoteStatus(status: string | null | undefined): status is LeadStatus {
  return (
    status === "new" ||
    status === "qualifying" ||
    status === "qualified" ||
    status === "handed_off" ||
    status === "ignored" ||
    status === "blocked" ||
    status === "rate_limited"
  );
}

function toE164(phoneNumber: string): string | null {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) {
    return null;
  }
  return `+${normalized}`;
}
