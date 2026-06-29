/**
 * SQLite database implementation
 */

import Database from "better-sqlite3";
import type { LeadEventRecord, LeadEventRejectedWrite } from "../crm-memory/lead-events.js";
import { eventMatchesLeadKey } from "../crm-memory/lead-events.js";
import type { Database as DatabaseInterface } from "../database.js";
import { normalizePhone } from "../utils/phone.js";
import type {
  Lead,
  LeadStatus,
  QualificationData,
  QuoteData,
  LeadStats,
  GlobalRateLimitRow,
  CircuitBreakerRow,
  ReceiptExtraction,
  ExtractionStatus,
  WhatsAppLabel,
  StoredMessage,
  PendingQuoteJob,
  CrmSyncOutboxRow,
  CrmSyncCheckpoint,
  LeadMemoryEventRow,
  LeadMemoryRejectedWriteRow,
  QuoteWebhookEventRow,
} from "./schema.js";
import {
  CREATE_TABLES_SQL,
  MIGRATE_V1_TO_V2_SQL,
  MIGRATE_V2_TO_V3_DDL,
  MIGRATE_V2_TO_V3_SEED_GLOBAL,
  MIGRATE_V2_TO_V3_SEED_BREAKER,
  MIGRATE_V3_TO_V4_DDL,
  MIGRATE_V4_TO_V5_DDL,
  MIGRATE_V5_TO_V6_DDL,
  MIGRATE_V5_TO_V6_TABLES,
  MIGRATE_V6_TO_V7_DDL,
  MIGRATE_V7_TO_V8_DDL,
  MIGRATE_V8_TO_V9_DDL,
  MIGRATE_V9_TO_V10_DDL,
  MIGRATE_V10_TO_V11_DDL,
  MIGRATE_V11_TO_V12_DDL,
  MIGRATE_V12_TO_V13_DDL,
  MIGRATE_V13_TO_V14_DDL,
  MIGRATE_V14_TO_V15_DDL,
  MIGRATE_V15_TO_V16_DDL,
  MIGRATE_V16_TO_V17_DDL,
  MIGRATE_V17_TO_V18_DDL,
  MIGRATE_V18_TO_V19_DDL,
  SCHEMA_VERSION,
} from "./schema.js";

export interface SqliteDatabaseConfig {
  dbPath: string;
}

export class SqliteDatabase implements DatabaseInterface {
  private db: Database.Database;

  constructor(config: SqliteDatabaseConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
  }

  migrate(): void {
    // Execute schema (creates tables if they don't exist)
    this.db.exec(CREATE_TABLES_SQL);

    // Check/update schema version
    const versionRow = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;

    if (!versionRow) {
      // Fresh database — seed singleton rows
      const now = Date.now();
      this.db.prepare(MIGRATE_V2_TO_V3_SEED_GLOBAL).run(now);
      this.db.prepare(MIGRATE_V2_TO_V3_SEED_BREAKER).run(now);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    } else if (versionRow.version < SCHEMA_VERSION) {
      if (versionRow.version < 2) {
        // v1→v2: add SOLAYRE columns (each ALTER TABLE individually — SQLite limitation)
        for (const stmt of MIGRATE_V1_TO_V2_SQL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              // Ignore "duplicate column name" — column already exists
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 3) {
        // v2→v3: add global rate limit + circuit breaker tables
        this.db.exec(MIGRATE_V2_TO_V3_DDL);
        const now = Date.now();
        this.db.prepare(MIGRATE_V2_TO_V3_SEED_GLOBAL).run(now);
        this.db.prepare(MIGRATE_V2_TO_V3_SEED_BREAKER).run(now);
      }
      if (versionRow.version < 4) {
        // v3→v4: add receipt_extractions table
        this.db.exec(MIGRATE_V3_TO_V4_DDL);
      }
      if (versionRow.version < 5) {
        // v4→v5: add whatsapp_labels table
        this.db.exec(MIGRATE_V4_TO_V5_DDL);
      }
      if (versionRow.version < 6) {
        // v5→v6: add receipt columns to leads + receipt_extractions table
        for (const stmt of MIGRATE_V5_TO_V6_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
        this.db.exec(MIGRATE_V5_TO_V6_TABLES);
      }
      if (versionRow.version < 7) {
        // v6→v7: add messages table
        this.db.exec(MIGRATE_V6_TO_V7_DDL);
      }
      if (versionRow.version < 8) {
        // v7→v8: add media columns to messages
        for (const stmt of MIGRATE_V7_TO_V8_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 9) {
        // v8→v9: add media_path column
        for (const stmt of MIGRATE_V8_TO_V9_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 10) {
        // v9→v10: add reaction/revoke/edit relationship columns
        for (const stmt of MIGRATE_V9_TO_V10_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 11) {
        // v10→v11: add peer_e164 column + index for E.164-keyed lookups (LID-aware)
        for (const stmt of MIGRATE_V10_TO_V11_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 12) {
        // v11→v12: follow-up tracking columns on leads
        for (const stmt of MIGRATE_V11_TO_V12_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 13) {
        // v12→v13: persist WhatsApp sender display name from raw metadata.
        for (const stmt of MIGRATE_V12_TO_V13_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 14) {
        // v13→v14: durable async CFE quote delivery jobs.
        this.db.exec(MIGRATE_V13_TO_V14_DDL);
      }
      if (versionRow.version < 15) {
        // v14→v15: recurrent OpenClaw ↔ Lovable CRM sync outbox and cursors.
        this.db.exec(MIGRATE_V14_TO_V15_DDL);
      }
      if (versionRow.version < 16) {
        // v15→v16: durable CRM memory event log, artifacts, and rejection audit.
        this.db.exec(MIGRATE_V15_TO_V16_DDL);
      }
      if (versionRow.version < 17) {
        // v16→v17: internal shadow quote URL metadata on async quote jobs.
        for (const stmt of MIGRATE_V16_TO_V17_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      if (versionRow.version < 18) {
        // v17→v18: durable signed quote webhook ingest and idempotency.
        this.db.exec(MIGRATE_V17_TO_V18_DDL);
      }
      if (versionRow.version < 19) {
        // v18→v19: remember the originating agent session for webhook resumptions.
        for (const stmt of MIGRATE_V18_TO_V19_DDL.split(";")) {
          const trimmed = stmt.trim();
          if (trimmed) {
            try {
              this.db.exec(trimmed);
            } catch (err: unknown) {
              if (!(err instanceof Error && err.message.includes("duplicate column"))) {
                throw err;
              }
            }
          }
        }
      }
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  close(): void {
    this.db.close();
  }

  async getOrCreateLead(phoneNumber: string): Promise<Lead> {
    const existing = await this.getLeadByPhone(phoneNumber);
    if (existing) {
      return existing;
    }

    // Store original phone (e.g. +5216691590605) — normalizePhone is for
    // lookups only; the stored value must be usable as a send target.
    const now = Date.now();
    const result = this.db
      .prepare(`
      INSERT INTO leads (
        phone_number, first_contact_at, last_message_at,
        status, custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, 'new', '{}', ?, ?)
    `)
      .run(phoneNumber, now, now, now, now);

    const lead = (await this.getLeadById(result.lastInsertRowid as number)) as Lead;
    await this.enqueueLeadSnapshotSync(lead.id);
    return lead;
  }

  async getLeadById(id: number): Promise<Lead | null> {
    const row = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead | undefined;
    return row || null;
  }

  async getLeadByPhone(phoneNumber: string): Promise<Lead | null> {
    // Try exact match, normalized (52...), and denormalized (+521...) variants —
    // so lookups work regardless of which format WhatsApp delivers the JID in.
    const normalized = normalizePhone(phoneNumber);
    // Denormalized: 52XXXXXXXXXX → +521XXXXXXXXXX (for records stored in old E.164 format)
    const denormalized =
      normalized.length === 12 && normalized.startsWith("52") ? "+521" + normalized.slice(2) : null;
    const row = denormalized
      ? (this.db
          .prepare(
            "SELECT * FROM leads WHERE phone_number = ? OR phone_number = ? OR phone_number = ?",
          )
          .get(phoneNumber, normalized, denormalized) as Lead | undefined)
      : (this.db
          .prepare("SELECT * FROM leads WHERE phone_number = ? OR phone_number = ?")
          .get(phoneNumber, normalized) as Lead | undefined);
    return row || null;
  }

  async updateLeadStatus(id: number, status: LeadStatus): Promise<void> {
    const now = Date.now();
    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    if (status === "handed_off") {
      this.db.prepare("UPDATE leads SET handed_off_at = ? WHERE id = ?").run(now, id);
    } else if (status === "blocked") {
      this.db.prepare("UPDATE leads SET blocked_at = ? WHERE id = ?").run(now, id);
    } else if (status === "rate_limited") {
      this.db.prepare("UPDATE leads SET rate_limited_at = ? WHERE id = ?").run(now, id);
    }
    await this.enqueueLeadSnapshotSync(id);
  }

  async updateLeadTimestamp(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET last_message_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
    await this.enqueueLeadSnapshotSync(id);
  }

  async updateAssignedAgent(id: number, agentPhone: string | null): Promise<void> {
    this.db
      .prepare("UPDATE leads SET assigned_agent = ?, updated_at = ? WHERE id = ?")
      .run(agentPhone, Date.now(), id);
    await this.enqueueLeadSnapshotSync(id);
  }

  async updateLastBotReply(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET last_bot_reply_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
  }

  async updateQualificationData(leadId: number, data: Partial<QualificationData>): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.location !== undefined) {
      updates.push("location = ?");
      values.push(data.location);
    }
    if (data.property_type !== undefined) {
      updates.push("property_type = ?");
      values.push(data.property_type);
    }
    if (data.ownership !== undefined) {
      updates.push("ownership = ?");
      values.push(data.ownership);
    }
    if (data.bimonthly_bill !== undefined) {
      updates.push("bimonthly_bill = ?");
      values.push(data.bimonthly_bill);
    }
    if (data.score !== undefined) {
      updates.push("score = ?");
      values.push(data.score);
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(Date.now());
      values.push(leadId);

      this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      await this.enqueueLeadSnapshotSync(leadId);
    }
  }

  async isLeadQualified(leadId: number): Promise<boolean> {
    const lead = await this.getLeadById(leadId);
    if (!lead) {
      return false;
    }

    return Boolean(
      lead.name && lead.location && lead.ownership && lead.bimonthly_bill && lead.property_type,
    );
  }

  async updateQuoteData(leadId: number, data: Partial<QuoteData>): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (data.panels_quoted !== undefined) {
      updates.push("panels_quoted = ?");
      values.push(data.panels_quoted);
    }
    if (data.quote_cash !== undefined) {
      updates.push("quote_cash = ?");
      values.push(data.quote_cash);
    }
    if (data.quote_financed !== undefined) {
      updates.push("quote_financed = ?");
      values.push(data.quote_financed);
    }
    if (data.quoted_at !== undefined) {
      updates.push("quoted_at = ?");
      values.push(data.quoted_at);
    }
    if (data.notes !== undefined) {
      updates.push("notes = ?");
      values.push(data.notes);
    }

    if (updates.length > 0) {
      updates.push("updated_at = ?");
      values.push(Date.now());
      values.push(leadId);

      this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      await this.enqueueLeadSnapshotSync(leadId);
    }
  }

  async logHandoffEvent(
    leadId: number,
    event: string,
    triggeredBy: string,
    metadata?: unknown,
  ): Promise<void> {
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.db
      .prepare(`
      INSERT INTO handoff_log (lead_id, event, triggered_by, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(leadId, event, triggeredBy, metadataJson, Date.now());
    await this.enqueueLeadSnapshotSync(leadId);
  }

  append(leadKey: string, event: LeadEventRecord): void {
    if (!eventMatchesLeadKey(leadKey, event)) {
      this.db
        .prepare(
          `INSERT INTO lead_memory_rejected_writes (
            attempted_event_id, attempted_lead_key, attempted_lead_phone,
            scoped_lead_key, reason, source_json, summary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.leadKey,
          event.leadPhone,
          leadKey,
          "cross_lead_event_write",
          JSON.stringify(event.source),
          event.summary,
          Date.now(),
        );

      throw new Error(
        `Cross-lead event write rejected: scoped lead ${leadKey} cannot receive event for ${event.leadKey}`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO lead_events (
          id, lead_key, lead_phone, type, actor, timestamp,
          source_json, summary, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.leadKey,
        event.leadPhone,
        event.type,
        event.actor,
        event.timestamp,
        JSON.stringify(event.source),
        event.summary,
        event.payload === undefined ? null : JSON.stringify(event.payload),
        Date.now(),
      );
  }

  read(leadKey: string): LeadEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lead_events
         WHERE lead_key = ?
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(leadKey) as LeadMemoryEventRow[];

    return rows.map((row) => ({
      id: row.id,
      leadKey: row.lead_key,
      leadPhone: row.lead_phone,
      type: row.type,
      actor: row.actor as LeadEventRecord["actor"],
      timestamp: row.timestamp,
      source: JSON.parse(row.source_json) as LeadEventRecord["source"],
      summary: row.summary,
      payload: row.payload_json === null ? undefined : JSON.parse(row.payload_json),
    }));
  }

  readRejectedWrites(): LeadEventRejectedWrite[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lead_memory_rejected_writes
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as LeadMemoryRejectedWriteRow[];

    return rows.map((row) => ({
      attemptedEventId: row.attempted_event_id,
      attemptedLeadKey: row.attempted_lead_key,
      attemptedLeadPhone: row.attempted_lead_phone,
      scopedLeadKey: row.scoped_lead_key,
      reason: "cross_lead_event_write",
      source: JSON.parse(row.source_json) as LeadEventRecord["source"],
      summary: row.summary,
    }));
  }

  async updateRateLimitCount(leadId: number, count: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET rate_limit_count = ?, updated_at = ? WHERE id = ?")
      .run(count, Date.now(), leadId);
  }

  async updateRateLimitWindow(leadId: number, windowStart: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET rate_limit_window_start = ?, updated_at = ? WHERE id = ?")
      .run(windowStart, Date.now(), leadId);
  }

  async resetRateLimit(leadId: number): Promise<void> {
    this.db
      .prepare(`
      UPDATE leads
      SET rate_limit_count = 0, rate_limit_window_start = NULL, rate_limited_at = NULL, updated_at = ?
      WHERE id = ?
    `)
      .run(Date.now(), leadId);
  }

  async blockLead(leadId: number, reason: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'blocked', blocked_at = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ?
    `)
      .run(now, reason, now, leadId);
    await this.enqueueLeadSnapshotSync(leadId);
  }

  async unblockLead(leadId: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'qualifying', blocked_at = NULL, blocked_reason = NULL, updated_at = ?
      WHERE id = ?
    `)
      .run(now, leadId);
    await this.enqueueLeadSnapshotSync(leadId);
  }

  async resetLead(leadId: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(`
      UPDATE leads
      SET status = 'qualifying',
          name = NULL, location = NULL, property_type = NULL, ownership = NULL,
          bimonthly_bill = NULL, score = NULL,
          panels_quoted = NULL, quote_cash = NULL, quote_financed = NULL, quoted_at = NULL,
          notes = NULL, assigned_agent = NULL, handed_off_at = NULL,
          blocked_at = NULL, blocked_reason = NULL,
          rate_limit_count = 0, rate_limit_window_start = NULL, rate_limited_at = NULL,
          follow_up_sent_at = NULL,
          receipt_data = NULL, tariff = NULL, annual_kwh = NULL,
          updated_at = ?
      WHERE id = ?
    `)
      .run(now, leadId);
    await this.enqueueLeadSnapshotSync(leadId);
  }

  async getSilentLeads(thresholdHours: number, maxFollowups: number): Promise<Lead[]> {
    const thresholdMs = thresholdHours * 60 * 60 * 1000;
    const cutoff = Date.now() - thresholdMs;

    const rows = this.db
      .prepare(`
      SELECT * FROM leads
      WHERE status = 'qualifying'
        AND last_message_at < ?
        AND (follow_up_sent_at IS NULL OR follow_up_sent_at < ?)
      LIMIT ?
    `)
      .all(cutoff, cutoff, maxFollowups) as Lead[];

    return rows;
  }

  async getFollowupCandidates(params?: {
    scores?: string[];
    statuses?: string[];
    limit?: number;
    minIdleMs?: number;
    maxAttempts?: number;
  }): Promise<Lead[]> {
    const scores = params?.scores ?? ["HOT", "WARM"];
    const statuses = params?.statuses ?? ["new", "qualifying"];
    const limit = params?.limit ?? 5;
    const minIdleMs = params?.minIdleMs ?? 3 * 24 * 60 * 60 * 1000; // 3 days
    const maxAttempts = params?.maxAttempts ?? 3;

    const cutoff = Date.now() - minIdleMs;
    const scorePlaceholders = scores.map(() => "?").join(", ");
    const statusPlaceholders = statuses.map(() => "?").join(", ");

    const rows = this.db
      .prepare(
        `SELECT l.* FROM leads l
         WHERE l.score IN (${scorePlaceholders})
           AND l.status IN (${statusPlaceholders})
           AND l.last_message_at < ?
           AND (l.follow_up_attempts IS NULL OR l.follow_up_attempts < ?)
           AND l.handed_off_at IS NULL
           AND l.blocked_at IS NULL
           AND l.rate_limited_at IS NULL
           AND l.receipt_data IS NULL
           AND l.annual_kwh IS NULL
           AND l.panels_quoted IS NULL
           AND l.quote_cash IS NULL
           AND l.quote_financed IS NULL
           AND l.quoted_at IS NULL
           AND LENGTH(REPLACE(l.phone_number, '+', '')) BETWEEN 10 AND 15
           AND REPLACE(l.phone_number, '+', '') GLOB '[0-9]*'
           AND REPLACE(l.phone_number, '+', '') NOT GLOB '*[^0-9]*'
           AND EXISTS (
             SELECT 1 FROM messages m
             WHERE REPLACE(m.peer_e164, '+', '') = REPLACE(l.phone_number, '+', '')
               AND m.from_me = 0
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_quote_jobs pqj
             WHERE REPLACE(pqj.customer_phone, '+', '') = REPLACE(l.phone_number, '+', '')
               AND pqj.status IN ('pending', 'delivered')
           )
         ORDER BY l.last_message_at ASC
         LIMIT ?`,
      )
      .all(...scores, ...statuses, cutoff, maxAttempts, limit) as Lead[];

    return rows;
  }

  async updateFollowUpSentAt(id: number, timestamp: number): Promise<void> {
    this.db
      .prepare("UPDATE leads SET follow_up_sent_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, Date.now(), id);
    await this.enqueueLeadSnapshotSync(id);
  }

  async getStats(): Promise<LeadStats> {
    const row = this.db
      .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new,
        SUM(CASE WHEN status = 'qualifying' THEN 1 ELSE 0 END) as qualifying,
        SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified,
        SUM(CASE WHEN status = 'handed_off' THEN 1 ELSE 0 END) as handedOff,
        SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) as ignored,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rateLimited
      FROM leads
    `)
      .get() as LeadStats;

    return row;
  }

  async getRecentLeads(limit: number): Promise<Lead[]> {
    const rows = this.db
      .prepare(`
      SELECT * FROM leads
      ORDER BY last_message_at DESC
      LIMIT ?
    `)
      .all(limit) as Lead[];

    return rows;
  }

  // --- Global rate limiting ---

  async getGlobalRateLimit(): Promise<GlobalRateLimitRow> {
    return this.db
      .prepare("SELECT * FROM global_rate_limit WHERE id = 1")
      .get() as GlobalRateLimitRow;
  }

  async incrementGlobalCount(): Promise<GlobalRateLimitRow> {
    const txn = this.db.transaction(() => {
      this.db
        .prepare("UPDATE global_rate_limit SET message_count = message_count + 1 WHERE id = 1")
        .run();
      return this.db
        .prepare("SELECT * FROM global_rate_limit WHERE id = 1")
        .get() as GlobalRateLimitRow;
    });
    return txn();
  }

  async resetGlobalWindow(now: number): Promise<void> {
    this.db
      .prepare("UPDATE global_rate_limit SET window_start = ?, message_count = 0 WHERE id = 1")
      .run(now);
  }

  // --- Circuit breaker ---

  async getCircuitBreaker(): Promise<CircuitBreakerRow> {
    return this.db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get() as CircuitBreakerRow;
  }

  async recordCircuitCheck(wasHit: boolean): Promise<CircuitBreakerRow> {
    const txn = this.db.transaction(() => {
      if (wasHit) {
        this.db
          .prepare(
            "UPDATE circuit_breaker SET total_checks = total_checks + 1, total_hits = total_hits + 1 WHERE id = 1",
          )
          .run();
      } else {
        this.db
          .prepare("UPDATE circuit_breaker SET total_checks = total_checks + 1 WHERE id = 1")
          .run();
      }
      return this.db
        .prepare("SELECT * FROM circuit_breaker WHERE id = 1")
        .get() as CircuitBreakerRow;
    });
    return txn();
  }

  async tripCircuitBreaker(reason: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE circuit_breaker SET is_tripped = 1, tripped_at = ?, trip_reason = ? WHERE id = 1",
      )
      .run(now, reason);
  }

  async resetCircuitBreaker(): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE circuit_breaker SET is_tripped = 0, tripped_at = NULL, trip_reason = NULL, reset_at = ?, total_checks = 0, total_hits = 0, window_start = ? WHERE id = 1",
      )
      .run(now, now);
  }

  async resetCircuitWindow(now: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE circuit_breaker SET total_checks = 0, total_hits = 0, window_start = ? WHERE id = 1",
      )
      .run(now);
  }

  // --- Atomic per-lead rate limit ---

  async checkAndRecordMessage(
    leadId: number,
    maxMessages: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; reason?: string }> {
    const txn = this.db.transaction(() => {
      const lead = this.db
        .prepare("SELECT rate_limit_count, rate_limit_window_start FROM leads WHERE id = ?")
        .get(leadId) as Pick<Lead, "rate_limit_count" | "rate_limit_window_start"> | undefined;

      if (!lead) {
        return { allowed: true, count: 0 };
      }

      const now = Date.now();
      const windowStart = lead.rate_limit_window_start || now;
      const elapsed = now - windowStart;

      // Window expired → reset and allow
      if (elapsed > windowMs || !lead.rate_limit_window_start) {
        this.db
          .prepare(
            "UPDATE leads SET rate_limit_count = 1, rate_limit_window_start = ?, updated_at = ? WHERE id = ?",
          )
          .run(now, now, leadId);
        return { allowed: true, count: 1 };
      }

      // Over limit → deny without incrementing
      if (lead.rate_limit_count >= maxMessages) {
        return {
          allowed: false,
          count: lead.rate_limit_count,
          reason: `Rate limit exceeded: ${lead.rate_limit_count} messages in ${Math.floor(elapsed / 60000)} minutes`,
        };
      }

      // Under limit → increment and allow
      const newCount = lead.rate_limit_count + 1;
      this.db
        .prepare("UPDATE leads SET rate_limit_count = ?, updated_at = ? WHERE id = ?")
        .run(newCount, now, leadId);

      return { allowed: true, count: newCount };
    });

    return txn();
  }

  // --- Receipt extraction tracking ---

  async createExtractionRecord(
    leadId: number,
    fileSize: number | null,
    filePath: string | null,
  ): Promise<number> {
    const now = Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO receipt_extractions (lead_id, status, spawned_at, file_size, file_path) VALUES (?, 'pending', ?, ?, ?)",
      )
      .run(leadId, now, fileSize, filePath);
    return result.lastInsertRowid as number;
  }

  async updateExtractionStatus(
    extractionId: number,
    status: ExtractionStatus,
    error: string | null = null,
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE receipt_extractions SET status = ?, completed_at = ?, error = ? WHERE id = ?",
      )
      .run(status, now, error, extractionId);
    const row = this.db
      .prepare("SELECT lead_id FROM receipt_extractions WHERE id = ?")
      .get(extractionId) as { lead_id: number } | undefined;
    if (row) {
      await this.enqueueLeadSnapshotSync(row.lead_id);
    }
  }

  async getExtractionAttempts(leadId: number): Promise<ReceiptExtraction[]> {
    return this.db
      .prepare("SELECT * FROM receipt_extractions WHERE lead_id = ? ORDER BY spawned_at DESC")
      .all(leadId) as ReceiptExtraction[];
  }

  async getPendingExtraction(leadId: number): Promise<ReceiptExtraction | null> {
    return (
      (this.db
        .prepare(
          "SELECT * FROM receipt_extractions WHERE lead_id = ? AND status = 'pending' ORDER BY spawned_at DESC LIMIT 1",
        )
        .get(leadId) as ReceiptExtraction | undefined) || null
    );
  }

  async updateCustomFields(leadId: number, fields: Record<string, unknown>): Promise<void> {
    const lead = await this.getLeadById(leadId);
    const existing = lead?.custom_fields ? JSON.parse(lead.custom_fields) : {};
    const merged = { ...existing, ...fields };
    this.db
      .prepare("UPDATE leads SET custom_fields = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), Date.now(), leadId);
    await this.enqueueLeadSnapshotSync(leadId);
  }

  async upsertLead(
    phone: string,
    data: Partial<
      import("./schema.js").QualificationData &
        import("./schema.js").QuoteData & {
          notes: string;
          follow_up_sent_at: number | null;
          follow_up_attempts: number;
          survey_sent_at: number | null;
          instagram_reminder_sent_at: number | null;
        }
    >,
  ): Promise<import("./schema.js").Lead> {
    const normalizedPhone = normalizePhone(phone);
    const existing = await this.getLeadByPhone(normalizedPhone);
    const now = Date.now();

    if (existing) {
      // Update only provided fields
      const updates: string[] = [];
      const values: unknown[] = [];

      if (data.name !== undefined) {
        updates.push("name = ?");
        values.push(data.name);
      }
      if (data.location !== undefined) {
        updates.push("location = ?");
        values.push(data.location);
      }
      if (data.property_type !== undefined) {
        updates.push("property_type = ?");
        values.push(data.property_type);
      }
      if (data.ownership !== undefined) {
        updates.push("ownership = ?");
        values.push(data.ownership);
      }
      if (data.bimonthly_bill !== undefined) {
        updates.push("bimonthly_bill = ?");
        values.push(data.bimonthly_bill);
      }
      if (data.score !== undefined) {
        updates.push("score = ?");
        values.push(data.score);
      }
      if (data.panels_quoted !== undefined) {
        updates.push("panels_quoted = ?");
        values.push(data.panels_quoted);
      }
      if (data.quote_cash !== undefined) {
        updates.push("quote_cash = ?");
        values.push(data.quote_cash);
      }
      if (data.quote_financed !== undefined) {
        updates.push("quote_financed = ?");
        values.push(data.quote_financed);
      }
      if (data.quoted_at !== undefined) {
        updates.push("quoted_at = ?");
        values.push(data.quoted_at);
      }
      if (data.notes !== undefined) {
        updates.push("notes = ?");
        values.push(data.notes);
      }
      if (data.follow_up_sent_at !== undefined) {
        updates.push("follow_up_sent_at = ?");
        values.push(data.follow_up_sent_at);
      }
      if (data.follow_up_attempts !== undefined) {
        updates.push("follow_up_attempts = ?");
        values.push(data.follow_up_attempts);
      }
      if (data.survey_sent_at !== undefined) {
        updates.push("survey_sent_at = ?");
        values.push(data.survey_sent_at);
      }
      if (data.instagram_reminder_sent_at !== undefined) {
        updates.push("instagram_reminder_sent_at = ?");
        values.push(data.instagram_reminder_sent_at);
      }

      if (updates.length > 0) {
        updates.push("updated_at = ?");
        values.push(now);
        values.push(existing.id);
        this.db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...values);
        await this.enqueueLeadSnapshotSync(existing.id);
      }

      return (await this.getLeadById(existing.id))!;
    }

    // Insert new lead
    const result = this.db
      .prepare(`
      INSERT INTO leads (
        phone_number, name, location, property_type, ownership, bimonthly_bill,
        score, panels_quoted, quote_cash, quote_financed, notes,
        status, custom_fields, first_contact_at, last_message_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '{}', ?, ?, ?, ?)
    `)
      .run(
        normalizedPhone,
        data.name ?? null,
        data.location ?? null,
        data.property_type ?? null,
        data.ownership ?? null,
        data.bimonthly_bill ?? null,
        data.score ?? null,
        data.panels_quoted ?? null,
        data.quote_cash ?? null,
        data.quote_financed ?? null,
        data.notes ?? null,
        now,
        now,
        now,
        now,
      );

    const lead = (await this.getLeadById(result.lastInsertRowid as number))!;
    await this.enqueueLeadSnapshotSync(lead.id);
    return lead;
  }

  async listLeads(filters?: { status?: string; score?: string }): Promise<Lead[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.status) {
      conditions.push("status = ?");
      values.push(filters.status);
    }
    if (filters?.score) {
      conditions.push("score = ?");
      values.push(filters.score);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM leads ${where} ORDER BY last_message_at DESC`)
      .all(...values) as Lead[];
  }

  async updateReceiptData(
    leadId: number,
    data: { receipt_data: string; tariff?: string; annual_kwh?: number },
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE leads SET receipt_data = ?, tariff = ?, annual_kwh = ?, updated_at = ? WHERE id = ?",
      )
      .run(data.receipt_data, data.tariff ?? null, data.annual_kwh ?? null, now, leadId);
    await this.enqueueLeadSnapshotSync(leadId);
  }

  async getRecentExtractionFailures(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const result = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM receipt_extractions WHERE status = 'failed' AND spawned_at > ?",
      )
      .get(cutoff) as { count: number } | undefined;
    return result?.count || 0;
  }

  // --- Async CFE quote delivery jobs ---

  async createPendingQuoteJob(input: {
    requestId: string;
    customerPhone: string;
    mediaPath: string;
    agentSessionKey?: string | null;
    agentSessionId?: string | null;
    invokingAgentId?: string | null;
    nextPollAt?: number;
  }): Promise<number> {
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO pending_quote_jobs (
          request_id, customer_phone, media_path, agent_session_key,
          agent_session_id, invoking_agent_id, status, attempts,
          next_poll_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          customer_phone = excluded.customer_phone,
          media_path = excluded.media_path,
          agent_session_key = excluded.agent_session_key,
          agent_session_id = excluded.agent_session_id,
          invoking_agent_id = excluded.invoking_agent_id,
          status = 'pending',
          attempts = 0,
          next_poll_at = excluded.next_poll_at,
          webhook_resumed_at = NULL,
          last_error = NULL,
          quote_id = NULL,
          quote_number = NULL,
          quote_access_token_id = NULL,
          quote_access_url = NULL,
          quote_access_expires_at = NULL,
          updated_at = excluded.updated_at,
          completed_at = NULL
        RETURNING id`,
      )
      .get(
        input.requestId,
        input.customerPhone,
        input.mediaPath,
        input.agentSessionKey ?? null,
        input.agentSessionId ?? null,
        input.invokingAgentId ?? null,
        input.nextPollAt ?? now,
        now,
        now,
      ) as { id: number } | undefined;
    if (!row) {
      throw new Error("failed to create pending quote job");
    }
    return row.id;
  }

  async getDuePendingQuoteJobs(now: number, limit: number): Promise<PendingQuoteJob[]> {
    return this.db
      .prepare(
        `SELECT * FROM pending_quote_jobs
         WHERE status = 'pending' AND next_poll_at <= ?
           AND webhook_resumed_at IS NULL
         ORDER BY next_poll_at ASC, id ASC
         LIMIT ?`,
      )
      .all(now, limit) as PendingQuoteJob[];
  }

  async getPendingQuoteJobByRequestId(requestId: string): Promise<PendingQuoteJob | null> {
    const row = this.db
      .prepare("SELECT * FROM pending_quote_jobs WHERE request_id = ?")
      .get(requestId) as PendingQuoteJob | undefined;
    return row ?? null;
  }

  async markPendingQuoteJobWebhookResumed(id: number, resumedAt = Date.now()): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE pending_quote_jobs
         SET webhook_resumed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND webhook_resumed_at IS NULL`,
      )
      .run(resumedAt, resumedAt, id);
    return result.changes > 0;
  }

  async reschedulePendingQuoteJob(
    id: number,
    input: { attempts: number; nextPollAt: number; lastError?: string | null },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE pending_quote_jobs
         SET attempts = ?, next_poll_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.attempts, input.nextPollAt, input.lastError ?? null, Date.now(), id);
  }

  async markPendingQuoteJobDelivered(
    id: number,
    input: {
      attempts: number;
      quoteId: string;
      quoteNumber: string;
      quoteAccess?: {
        tokenId: string;
        url: string;
        expiresAt: number;
      } | null;
    },
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE pending_quote_jobs
         SET status = 'delivered', attempts = ?, quote_id = ?, quote_number = ?,
             quote_access_token_id = ?, quote_access_url = ?, quote_access_expires_at = ?,
             last_error = NULL, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        input.attempts,
        input.quoteId,
        input.quoteNumber,
        input.quoteAccess?.tokenId ?? null,
        input.quoteAccess?.url ?? null,
        input.quoteAccess?.expiresAt ?? null,
        now,
        now,
        id,
      );
    const job = this.db
      .prepare("SELECT customer_phone FROM pending_quote_jobs WHERE id = ?")
      .get(id) as { customer_phone: string } | undefined;
    if (job) {
      const lead = await this.getLeadByPhone(job.customer_phone);
      if (lead) {
        await this.enqueueLeadSnapshotSync(lead.id);
      }
    }
  }

  async markPendingQuoteJobFailed(
    id: number,
    input: {
      attempts: number;
      error: string;
      quoteId?: string | null;
      quoteNumber?: string | null;
    },
  ): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE pending_quote_jobs
         SET status = 'failed', attempts = ?, last_error = ?, quote_id = ?,
             quote_number = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        input.attempts,
        input.error,
        input.quoteId ?? null,
        input.quoteNumber ?? null,
        now,
        now,
        id,
      );
    const job = this.db
      .prepare("SELECT customer_phone FROM pending_quote_jobs WHERE id = ?")
      .get(id) as { customer_phone: string } | undefined;
    if (job) {
      const lead = await this.getLeadByPhone(job.customer_phone);
      if (lead) {
        await this.enqueueLeadSnapshotSync(lead.id);
      }
    }
  }

  async recordQuoteWebhookEvent(input: {
    source: string;
    eventId: string;
    eventType: string;
    requestId?: string | null;
    subject?: string | null;
    payload: unknown;
    receivedAt?: number;
  }): Promise<{ row: QuoteWebhookEventRow; duplicate: boolean }> {
    const now = input.receivedAt ?? Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO quote_webhook_events (
          source, event_id, event_type, request_id, subject, payload_json,
          status, duplicate_count, first_received_at, last_received_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)
        ON CONFLICT(source, event_id) DO UPDATE SET
          duplicate_count = quote_webhook_events.duplicate_count + 1,
          last_received_at = excluded.last_received_at
        RETURNING *`,
      )
      .get(
        input.source,
        input.eventId,
        input.eventType,
        input.requestId ?? null,
        input.subject ?? null,
        JSON.stringify(input.payload ?? null),
        now,
        now,
      ) as QuoteWebhookEventRow | undefined;
    if (!row) {
      throw new Error("failed to record quote webhook event");
    }
    return { row, duplicate: row.duplicate_count > 0 };
  }

  // --- CRM sync outbox ---

  async enqueueCrmSyncEvent(input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string | number;
    idempotencyKey: string;
    payload: unknown;
    nextAttemptAt?: number;
  }): Promise<number> {
    const now = Date.now();
    const nextAttemptAt = input.nextAttemptAt ?? now;
    const row = this.db
      .prepare(
        `INSERT INTO crm_sync_outbox (
          event_type, aggregate_type, aggregate_id, idempotency_key, payload_json,
          status, attempts, next_attempt_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          event_type = excluded.event_type,
          aggregate_type = excluded.aggregate_type,
          aggregate_id = excluded.aggregate_id,
          payload_json = excluded.payload_json,
          status = 'pending',
          attempts = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
        RETURNING id`,
      )
      .get(
        input.eventType,
        input.aggregateType,
        String(input.aggregateId),
        input.idempotencyKey,
        JSON.stringify(input.payload),
        nextAttemptAt,
        now,
        now,
      ) as { id: number } | undefined;

    if (!row) {
      throw new Error("failed to enqueue CRM sync event");
    }
    return row.id;
  }

  async enqueueLeadSnapshotSync(leadId: number): Promise<void> {
    const lead = await this.getLeadById(leadId);
    if (!lead) {
      return;
    }
    await this.enqueueCrmSyncEvent({
      eventType: "lead_snapshot_changed",
      aggregateType: "lead",
      aggregateId: lead.id,
      idempotencyKey: `lead_snapshot:lead:${lead.id}`,
      payload: {
        leadId: lead.id,
        phoneNumber: lead.phone_number,
        updatedAt: lead.updated_at,
      },
    });
  }

  async getDueCrmSyncOutbox(now: number, limit: number): Promise<CrmSyncOutboxRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM crm_sync_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, id ASC
         LIMIT ?`,
      )
      .all(now, limit) as CrmSyncOutboxRow[];
  }

  async markCrmSyncOutboxSynced(id: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE crm_sync_outbox
         SET status = 'synced', last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  async rescheduleCrmSyncOutbox(
    id: number,
    input: { attempts: number; nextAttemptAt: number; lastError?: string | null },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE crm_sync_outbox
         SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.attempts, input.nextAttemptAt, input.lastError ?? null, Date.now(), id);
  }

  async markCrmSyncOutboxFailed(
    id: number,
    input: { attempts: number; error: string },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE crm_sync_outbox
         SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.attempts, input.error, Date.now(), id);
  }

  async getCrmSyncCheckpoint(name: string): Promise<CrmSyncCheckpoint | null> {
    const row = this.db.prepare("SELECT * FROM crm_sync_checkpoints WHERE name = ?").get(name) as
      | CrmSyncCheckpoint
      | undefined;
    return row ?? null;
  }

  async setCrmSyncCheckpoint(
    name: string,
    cursor: string | null,
    syncedAt = Date.now(),
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO crm_sync_checkpoints (name, cursor, synced_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           cursor = excluded.cursor,
           synced_at = excluded.synced_at`,
      )
      .run(name, cursor, syncedAt);
  }

  // --- WhatsApp label store ---

  async getLabelId(name: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT wa_label_id FROM whatsapp_labels WHERE name = ?")
      .get(name) as { wa_label_id: string } | undefined;
    return row?.wa_label_id ?? null;
  }

  async upsertLabel(name: string, waLabelId: string, color: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO whatsapp_labels (name, wa_label_id, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET wa_label_id = excluded.wa_label_id, color = excluded.color, updated_at = excluded.updated_at`,
      )
      .run(name, waLabelId, color, now, now);
  }

  async getAllLabels(): Promise<WhatsAppLabel[]> {
    return this.db.prepare("SELECT * FROM whatsapp_labels").all() as WhatsAppLabel[];
  }

  // --- MessageStore ---

  private insertMessageStatement?: ReturnType<Database.Database["prepare"]>;
  private get insertMessageStmt() {
    return (this.insertMessageStatement ??= this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, sender_name, from_me, timestamp, content, message_type, media_type, media_filename, media_size, media_path, reaction_emoji, reaction_target_id, revoked_target_id, edited_from_id, peer_e164, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ));
  }

  private runInsertMessage(msg: StoredMessage): void {
    this.insertMessageStmt.run(
      msg.id,
      msg.chat_jid,
      msg.sender_jid,
      msg.sender_name ?? null,
      msg.from_me,
      msg.timestamp,
      msg.content,
      msg.message_type,
      msg.media_type,
      msg.media_filename,
      msg.media_size,
      msg.media_path,
      msg.reaction_emoji,
      msg.reaction_target_id,
      msg.revoked_target_id,
      msg.edited_from_id,
      msg.peer_e164,
      msg.created_at,
    );
  }

  // Backfill peer_e164 for all rows of a given chat_jid that don't yet have it set.
  // Used when message_received fires after the raw insert and we know the resolved E.164.
  setPeerE164ByChatJidSync(chatJid: string, peerE164: string): void {
    this.db
      .prepare(
        "UPDATE messages SET peer_e164 = ? WHERE chat_jid = ? AND (peer_e164 IS NULL OR peer_e164 = '')",
      )
      .run(peerE164, chatJid);
  }

  // Synchronous reader keyed by E.164 (uses idx_messages_peer_e164).
  getMessagesByPeerE164Sync(peerE164: string, limit = 100): StoredMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE peer_e164 = ? ORDER BY timestamp ASC LIMIT ?")
      .all(peerE164, limit) as StoredMessage[];
  }

  getLatestMessageByPeerE164Sync(peerE164: string): StoredMessage | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE peer_e164 = ? ORDER BY timestamp DESC LIMIT 1")
      .get(peerE164) as StoredMessage | undefined;
    return row ?? null;
  }

  private updateMediaStatement?: ReturnType<Database.Database["prepare"]>;
  private get updateMediaStmt() {
    return (this.updateMediaStatement ??= this.db.prepare(
      `UPDATE messages
         SET media_path = COALESCE(?, media_path),
             media_type = COALESCE(?, media_type),
             media_filename = COALESCE(?, media_filename)
         WHERE id = ?`,
    ));
  }

  updateMessageMediaSync(
    id: string,
    media: { mediaPath?: string | null; mediaType?: string | null; mediaFileName?: string | null },
  ): void {
    this.updateMediaStmt.run(
      media.mediaPath ?? null,
      media.mediaType ?? null,
      media.mediaFileName ?? null,
      id,
    );
  }

  async storeMessage(msg: StoredMessage): Promise<void> {
    this.runInsertMessage(msg);
  }

  async storeMessages(msgs: StoredMessage[]): Promise<void> {
    const batch = this.db.transaction((rows: StoredMessage[]) => {
      for (const row of rows) {
        this.runInsertMessage(row);
      }
    });
    batch(msgs);
  }

  async getMessages(
    chatJid: string,
    opts?: { limit?: number; before?: number },
  ): Promise<StoredMessage[]> {
    const limit = opts?.limit ?? 50;
    if (opts?.before) {
      return this.db
        .prepare(
          "SELECT * FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?",
        )
        .all(chatJid, opts.before, limit) as StoredMessage[];
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?")
      .all(chatJid, limit) as StoredMessage[];
  }

  async getMessagesSince(chatJid: string, sinceTimestamp: number): Promise<StoredMessage[]> {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_jid = ? AND timestamp >= ? ORDER BY timestamp ASC",
      )
      .all(chatJid, sinceTimestamp) as StoredMessage[];
  }

  // Synchronous reader for hot-path callers (better-sqlite3 is fully synchronous).
  // Returns oldest-first up to `limit`.
  getMessagesSync(chatJid: string, limit = 100): StoredMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC LIMIT ?")
      .all(chatJid, limit) as StoredMessage[];
  }
}
