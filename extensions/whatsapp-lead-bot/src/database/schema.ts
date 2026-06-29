/**
 * Database schema types and constants
 */

export type LeadStatus =
  | "new"
  | "qualifying"
  | "qualified"
  | "handed_off"
  | "ignored"
  | "blocked"
  | "rate_limited";

export interface Lead {
  id: number;
  phone_number: string;
  first_contact_at: number;
  last_message_at: number;
  last_bot_reply_at: number | null;
  status: LeadStatus;
  assigned_agent: string | null;
  handed_off_at: number | null;
  blocked_at: number | null;
  blocked_reason: string | null;
  rate_limited_at: number | null;
  rate_limit_count: number;
  rate_limit_window_start: number | null;
  follow_up_sent_at: number | null;
  follow_up_attempts: number;
  survey_sent_at: number | null;
  instagram_reminder_sent_at: number | null;
  language: string | null;
  name: string | null;
  location: string | null;
  property_type: string | null;
  ownership: string | null;
  bimonthly_bill: number | null;
  score: string | null;
  panels_quoted: number | null;
  quote_cash: number | null;
  quote_financed: number | null;
  quoted_at: number | null;
  notes: string | null;
  receipt_data: string | null; // JSON blob from CFE parse
  tariff: string | null;
  annual_kwh: number | null;
  custom_fields: string; // JSON blob
  created_at: number;
  updated_at: number;
}

export interface HandoffLog {
  id: number;
  lead_id: number;
  event: string;
  triggered_by: string;
  metadata: string | null; // JSON blob
  timestamp: number;
}

export interface QualificationData {
  name?: string;
  location?: string;
  property_type?: string;
  ownership?: string;
  bimonthly_bill?: number;
  score?: string;
}

export interface QuoteData {
  panels_quoted?: number;
  quote_cash?: number;
  quote_financed?: number;
  quoted_at?: number;
  notes?: string;
}

export interface LeadStats {
  total: number;
  new: number;
  qualifying: number;
  qualified: number;
  handedOff: number;
  ignored: number;
  blocked: number;
  rateLimited: number;
}

export interface GlobalRateLimitRow {
  id: number;
  window_start: number;
  message_count: number;
}

export interface CircuitBreakerRow {
  id: number;
  is_tripped: number; // 0 or 1
  tripped_at: number | null;
  trip_reason: string | null;
  reset_at: number | null;
  total_checks: number;
  total_hits: number;
  window_start: number;
}

export type ExtractionStatus = "pending" | "success" | "failed";

export interface ReceiptExtraction {
  id: number;
  lead_id: number;
  status: ExtractionStatus;
  spawned_at: number;
  completed_at: number | null;
  error: string | null;
  file_size: number | null;
  file_path: string | null;
}

export interface WhatsAppLabel {
  name: string;
  wa_label_id: string;
  color: number;
  created_at: number;
  updated_at: number;
}

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name?: string | null;
  from_me: number; // 0 or 1
  timestamp: number; // epoch seconds
  content: string | null;
  message_type: string | null;
  media_type: string | null; // mimetype, e.g. "image/jpeg", "audio/ogg"
  media_filename: string | null;
  media_size: number | null; // bytes
  media_path: string | null; // local filesystem path (set by enriched event after download)
  reaction_emoji: string | null; // when message_type=reactionMessage
  reaction_target_id: string | null; // id of the message this reaction targets
  revoked_target_id: string | null; // when this message is a REVOKE protocolMessage, the target msg id
  edited_from_id: string | null; // when this message is a MESSAGE_EDIT, the original msg id (new content lives in `content`)
  peer_e164: string | null; // resolved E.164 of the conversation peer (set when known; LID conversations have @lid in chat_jid)
  created_at: number;
}

export type PendingQuoteJobStatus = "pending" | "delivered" | "failed";

export interface PendingQuoteJob {
  id: number;
  request_id: string;
  customer_phone: string;
  media_path: string;
  agent_session_key?: string | null;
  agent_session_id?: string | null;
  invoking_agent_id?: string | null;
  status: PendingQuoteJobStatus;
  attempts: number;
  next_poll_at: number;
  webhook_resumed_at?: number | null;
  last_error: string | null;
  quote_id: string | null;
  quote_number: string | null;
  quote_access_token_id: string | null;
  quote_access_url: string | null;
  quote_access_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type CrmSyncOutboxStatus = "pending" | "processing" | "synced" | "failed";

export interface CrmSyncOutboxRow {
  id: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  idempotency_key: string;
  payload_json: string;
  status: CrmSyncOutboxStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CrmSyncCheckpoint {
  name: string;
  cursor: string | null;
  synced_at: number;
}

export interface LeadMemoryEventRow {
  id: string;
  lead_key: string;
  lead_phone: string;
  type: string;
  actor: string;
  timestamp: number;
  source_json: string;
  summary: string;
  payload_json: string | null;
  created_at: number;
}

export interface LeadMemoryRejectedWriteRow {
  id: number;
  attempted_event_id: string;
  attempted_lead_key: string;
  attempted_lead_phone: string;
  scoped_lead_key: string;
  reason: string;
  source_json: string;
  summary: string;
  created_at: number;
}

export interface QuoteWebhookEventRow {
  id: number;
  source: string;
  event_id: string;
  event_type: string;
  request_id: string | null;
  subject: string | null;
  payload_json: string;
  status: string;
  duplicate_count: number;
  first_received_at: number;
  last_received_at: number;
  processed_at: number | null;
  last_error: string | null;
}

export const PENDING_QUOTE_JOBS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS pending_quote_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT UNIQUE NOT NULL,
  customer_phone TEXT NOT NULL,
  media_path TEXT NOT NULL,
  agent_session_key TEXT,
  agent_session_id TEXT,
  invoking_agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at INTEGER NOT NULL,
  webhook_resumed_at INTEGER,
  last_error TEXT,
  quote_id TEXT,
  quote_number TEXT,
  quote_access_token_id TEXT,
  quote_access_url TEXT,
  quote_access_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pending_quote_jobs_status_next
  ON pending_quote_jobs(status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_pending_quote_jobs_customer
  ON pending_quote_jobs(customer_phone, created_at);
`;

export const CRM_SYNC_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS crm_sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_due
  ON crm_sync_outbox(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_aggregate
  ON crm_sync_outbox(aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS crm_sync_checkpoints (
  name TEXT PRIMARY KEY,
  cursor TEXT,
  synced_at INTEGER NOT NULL
);
`;

export const QUOTE_WEBHOOK_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS quote_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT,
  subject TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  processed_at INTEGER,
  last_error TEXT,
  UNIQUE(source, event_id)
);

CREATE INDEX IF NOT EXISTS idx_quote_webhook_events_status
  ON quote_webhook_events(status, first_received_at, id);
CREATE INDEX IF NOT EXISTS idx_quote_webhook_events_request
  ON quote_webhook_events(request_id, first_received_at);
`;

export const CRM_MEMORY_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY,
  lead_key TEXT NOT NULL,
  lead_phone TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead_time
  ON lead_events(lead_key, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_lead_events_type_time
  ON lead_events(type, timestamp);

CREATE TABLE IF NOT EXISTS lead_artifacts (
  id TEXT PRIMARY KEY,
  lead_key TEXT NOT NULL,
  lead_phone TEXT NOT NULL,
  type TEXT NOT NULL,
  pointer TEXT NOT NULL,
  checksum TEXT,
  source_json TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_artifacts_lead
  ON lead_artifacts(lead_key, created_at);

CREATE TABLE IF NOT EXISTS lead_memory_rejected_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_event_id TEXT NOT NULL,
  attempted_lead_key TEXT NOT NULL,
  attempted_lead_phone TEXT NOT NULL,
  scoped_lead_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_memory_rejected_writes_scoped
  ON lead_memory_rejected_writes(scoped_lead_key, created_at);
`;

export const MESSAGES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  from_me INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  content TEXT,
  message_type TEXT,
  media_type TEXT,
  media_filename TEXT,
  media_size INTEGER,
  media_path TEXT,
  reaction_emoji TEXT,
  reaction_target_id TEXT,
  revoked_target_id TEXT,
  edited_from_id TEXT,
  peer_e164 TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_peer_e164 ON messages(peer_e164, timestamp);
`;

export const MIGRATE_V7_TO_V8_DDL = `
ALTER TABLE messages ADD COLUMN media_type TEXT;
ALTER TABLE messages ADD COLUMN media_filename TEXT;
ALTER TABLE messages ADD COLUMN media_size INTEGER;
`;

export const MIGRATE_V8_TO_V9_DDL = `
ALTER TABLE messages ADD COLUMN media_path TEXT;
`;

export const MIGRATE_V9_TO_V10_DDL = `
ALTER TABLE messages ADD COLUMN reaction_emoji TEXT;
ALTER TABLE messages ADD COLUMN reaction_target_id TEXT;
ALTER TABLE messages ADD COLUMN revoked_target_id TEXT;
ALTER TABLE messages ADD COLUMN edited_from_id TEXT;
`;

export const MIGRATE_V10_TO_V11_DDL = `
ALTER TABLE messages ADD COLUMN peer_e164 TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_peer_e164 ON messages(peer_e164, timestamp);
`;

export const MIGRATE_V11_TO_V12_DDL = `
ALTER TABLE leads ADD COLUMN follow_up_attempts INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN survey_sent_at INTEGER;
ALTER TABLE leads ADD COLUMN instagram_reminder_sent_at INTEGER;
`;

export const MIGRATE_V12_TO_V13_DDL = `
ALTER TABLE messages ADD COLUMN sender_name TEXT;
`;

export const MIGRATE_V13_TO_V14_DDL = PENDING_QUOTE_JOBS_TABLE_DDL;

export const MIGRATE_V14_TO_V15_DDL = CRM_SYNC_TABLES_DDL;

export const MIGRATE_V15_TO_V16_DDL = CRM_MEMORY_TABLES_DDL;

export const MIGRATE_V16_TO_V17_DDL = `
ALTER TABLE pending_quote_jobs ADD COLUMN quote_access_token_id TEXT;
ALTER TABLE pending_quote_jobs ADD COLUMN quote_access_url TEXT;
ALTER TABLE pending_quote_jobs ADD COLUMN quote_access_expires_at INTEGER;
`;

export const MIGRATE_V17_TO_V18_DDL = QUOTE_WEBHOOK_EVENTS_TABLE_DDL;

export const MIGRATE_V18_TO_V19_DDL = `
ALTER TABLE pending_quote_jobs ADD COLUMN agent_session_key TEXT;
ALTER TABLE pending_quote_jobs ADD COLUMN agent_session_id TEXT;
ALTER TABLE pending_quote_jobs ADD COLUMN invoking_agent_id TEXT;
ALTER TABLE pending_quote_jobs ADD COLUMN webhook_resumed_at INTEGER;
`;

export const SCHEMA_VERSION = 19;

export const CREATE_TABLES_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT UNIQUE NOT NULL,
  first_contact_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  last_bot_reply_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_agent TEXT,
  handed_off_at INTEGER,
  blocked_at INTEGER,
  blocked_reason TEXT,
  rate_limited_at INTEGER,
  rate_limit_count INTEGER DEFAULT 0,
  rate_limit_window_start INTEGER,
  follow_up_sent_at INTEGER,
  language TEXT,
  name TEXT,
  location TEXT,
  property_type TEXT,
  ownership TEXT,
  bimonthly_bill REAL,
  score TEXT,
  panels_quoted INTEGER,
  quote_cash REAL,
  quote_financed REAL,
  quoted_at INTEGER,
  notes TEXT,
  receipt_data TEXT,
  tariff TEXT,
  annual_kwh REAL,
  custom_fields TEXT DEFAULT '{}',
  follow_up_attempts INTEGER DEFAULT 0,
  survey_sent_at INTEGER,
  instagram_reminder_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_number);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_last_message ON leads(last_message_at);

-- Handoff log table
CREATE TABLE IF NOT EXISTS handoff_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_handoff_log_lead ON handoff_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_handoff_log_timestamp ON handoff_log(timestamp);

-- Global rate limit (singleton row)
CREATE TABLE IF NOT EXISTS global_rate_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- Circuit breaker (singleton row)
CREATE TABLE IF NOT EXISTS circuit_breaker (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_tripped INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  trip_reason TEXT,
  reset_at INTEGER,
  total_checks INTEGER NOT NULL DEFAULT 0,
  total_hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Receipt extraction tracking
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);

-- WhatsApp label name→ID mappings
CREATE TABLE IF NOT EXISTS whatsapp_labels (
  name TEXT PRIMARY KEY,
  wa_label_id TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

${MESSAGES_TABLE_DDL}

${PENDING_QUOTE_JOBS_TABLE_DDL}

${CRM_SYNC_TABLES_DDL}

${CRM_MEMORY_TABLES_DDL}

${QUOTE_WEBHOOK_EVENTS_TABLE_DDL}
`;

export const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE leads ADD COLUMN name TEXT;
ALTER TABLE leads ADD COLUMN property_type TEXT;
ALTER TABLE leads ADD COLUMN ownership TEXT;
ALTER TABLE leads ADD COLUMN bimonthly_bill REAL;
ALTER TABLE leads ADD COLUMN score TEXT;
ALTER TABLE leads ADD COLUMN panels_quoted INTEGER;
ALTER TABLE leads ADD COLUMN quote_cash REAL;
ALTER TABLE leads ADD COLUMN quote_financed REAL;
ALTER TABLE leads ADD COLUMN quoted_at INTEGER;
ALTER TABLE leads ADD COLUMN notes TEXT;
`;

export const MIGRATE_V2_TO_V3_DDL = `
CREATE TABLE IF NOT EXISTS global_rate_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS circuit_breaker (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_tripped INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  trip_reason TEXT,
  reset_at INTEGER,
  total_checks INTEGER NOT NULL DEFAULT 0,
  total_hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
`;

export const MIGRATE_V2_TO_V3_SEED_GLOBAL = `INSERT OR IGNORE INTO global_rate_limit (id, window_start, message_count) VALUES (1, ?, 0)`;
export const MIGRATE_V2_TO_V3_SEED_BREAKER = `INSERT OR IGNORE INTO circuit_breaker (id, is_tripped, window_start) VALUES (1, 0, ?)`;

export const MIGRATE_V3_TO_V4_DDL = `
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);
`;

export const MIGRATE_V4_TO_V5_DDL = `
CREATE TABLE IF NOT EXISTS whatsapp_labels (
  name TEXT PRIMARY KEY,
  wa_label_id TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const MIGRATE_V5_TO_V6_DDL = `
ALTER TABLE leads ADD COLUMN receipt_data TEXT;
ALTER TABLE leads ADD COLUMN tariff TEXT;
ALTER TABLE leads ADD COLUMN annual_kwh REAL;
`;

export const MIGRATE_V5_TO_V6_TABLES = `
CREATE TABLE IF NOT EXISTS receipt_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  file_size INTEGER,
  file_path TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_extractions_lead ON receipt_extractions(lead_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON receipt_extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_spawned ON receipt_extractions(spawned_at);
`;

export const MIGRATE_V6_TO_V7_DDL = MESSAGES_TABLE_DDL;
