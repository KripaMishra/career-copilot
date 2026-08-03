import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { assertOperationalDatabaseUrl } from '../config/runtime.ts';

export type JobIdentity = { url?: string; company?: string; title?: string; location?: string };
export type JobState = 'pending' | 'succeeded' | 'failed';
export type IdempotencyRecord = {
  key: string;
  firstRequestId: string;
  sightings: number;
  lastRequestId?: string;
  lastSourceId?: string;
};

type Migration = Readonly<{ version: number; name: string; sql: string; checksum: string }>;

const legacyBaselineSql = `
CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE career_idempotency (
  key TEXT PRIMARY KEY,
  first_request_id TEXT NOT NULL,
  sightings INTEGER NOT NULL DEFAULT 0,
  last_request_id TEXT,
  last_source_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER,
  error TEXT
) STRICT;
CREATE TABLE career_outbox (
  request_id TEXT NOT NULL,
  step TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  payload TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, step)
) STRICT;
`;

const emptyCompatibilityBaselineSql = `
CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE career_idempotency (
  key TEXT PRIMARY KEY,
  first_request_id TEXT NOT NULL,
  sightings INTEGER NOT NULL DEFAULT 0,
  last_request_id TEXT,
  last_source_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER,
  error TEXT
) STRICT;
`;

const legacyCompatibilitySql = `
CREATE TABLE IF NOT EXISTS career_requests (request_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE IF NOT EXISTS career_idempotency (
  key TEXT PRIMARY KEY,
  first_request_id TEXT NOT NULL,
  sightings INTEGER NOT NULL DEFAULT 0,
  last_request_id TEXT,
  last_source_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER,
  error TEXT
) STRICT;
ALTER TABLE career_requests RENAME TO career_requests_legacy_v0;
ALTER TABLE career_idempotency RENAME TO career_idempotency_legacy_v0;
CREATE TABLE career_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) > 0)
) STRICT;
CREATE TABLE career_idempotency (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  first_request_id TEXT NOT NULL CHECK (length(first_request_id) > 0),
  sightings INTEGER NOT NULL DEFAULT 0 CHECK (sightings >= 0),
  last_request_id TEXT,
  last_source_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'failed')),
  lease_until INTEGER CHECK (lease_until IS NULL OR lease_until >= 0),
  error TEXT
) STRICT;
INSERT INTO career_requests SELECT request_id FROM career_requests_legacy_v0;
INSERT INTO career_idempotency SELECT key, first_request_id, sightings, last_request_id, last_source_id, state, lease_until, error FROM career_idempotency_legacy_v0;
DROP TABLE career_requests_legacy_v0;
DROP TABLE career_idempotency_legacy_v0;
`;

const durableRecordsSql = `
CREATE TABLE career_inbound_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  channel TEXT NOT NULL,
  transport_event_id TEXT NOT NULL,
  normalized_hash TEXT NOT NULL CHECK (length(normalized_hash) = 71 AND substr(normalized_hash, 1, 7) = 'sha256:' AND substr(normalized_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  owner_resource_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected')),
  rejection_reason TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (channel, transport_event_id)
) STRICT;

CREATE TABLE career_commands (
  queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  attempt_id TEXT NOT NULL UNIQUE,
  parent_command_id TEXT REFERENCES career_commands(command_id),
  request_id TEXT NOT NULL,
  canonical_job_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  owner_resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  origin_channel TEXT NOT NULL,
  origin_destination TEXT NOT NULL,
  queue_state TEXT NOT NULL CHECK (queue_state IN ('queued', 'starting', 'running', 'retry_wait', 'suspended', 'resuming', 'succeeded', 'failed', 'timed_out')),
  workflow_version INTEGER NOT NULL DEFAULT 1 CHECK (workflow_version > 0),
  workflow_attempt INTEGER NOT NULL DEFAULT 1 CHECK (workflow_attempt > 0),
  run_id TEXT,
  start_dispatch_state TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (start_dispatch_state IN ('not_dispatched', 'dispatching', 'dispatched', 'start_unknown')),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  repeat_budget_remaining INTEGER NOT NULL DEFAULT 5 CHECK (repeat_budget_remaining BETWEEN 0 AND 5),
  processing_started_at INTEGER,
  processing_deadline_at INTEGER,
  retry_due_at INTEGER,
  error_class TEXT,
  error_code TEXT,
  last_safe_error TEXT,
  suspension_generation INTEGER NOT NULL DEFAULT 0 CHECK (suspension_generation >= 0),
  blocker_id TEXT,
  terminal_generation INTEGER NOT NULL DEFAULT 0 CHECK (terminal_generation >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  queued_at INTEGER NOT NULL CHECK (queued_at >= created_at),
  started_at INTEGER,
  completed_at INTEGER,
  resolved_at INTEGER,
  retention_deadline_at INTEGER,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL AND claim_generation > 0)),
  CHECK ((queue_state IN ('starting', 'running', 'resuming')) = (lease_owner IS NOT NULL)),
  CHECK ((queue_state = 'queued' AND run_id IS NULL AND start_dispatch_state = 'not_dispatched' AND processing_started_at IS NULL AND processing_deadline_at IS NULL AND retry_due_at IS NULL) OR (queue_state <> 'queued' AND run_id IS NOT NULL AND processing_started_at IS NOT NULL)),
  CHECK (queue_state <> 'starting' OR run_id = 'cc-save-v1:' || command_id || ':' || workflow_attempt),
  CHECK (queue_state NOT IN ('running', 'retry_wait', 'suspended', 'resuming', 'succeeded') OR start_dispatch_state = 'dispatched'),
  CHECK (queue_state NOT IN ('succeeded', 'failed', 'timed_out') OR start_dispatch_state <> 'start_unknown' OR (error_class IS NOT NULL AND error_code IS NOT NULL AND last_safe_error IS NOT NULL)),
  CHECK ((queue_state = 'retry_wait') = (retry_due_at IS NOT NULL)),
  CHECK ((queue_state IN ('suspended', 'resuming')) = (suspension_generation > 0 AND blocker_id IS NOT NULL)),
  CHECK ((blocker_id IS NOT NULL) = (queue_state IN ('suspended', 'resuming'))),
  CHECK (queue_state <> 'suspended' OR processing_deadline_at IS NULL),
  CHECK (queue_state IN ('queued', 'suspended') OR processing_deadline_at IS NOT NULL OR (queue_state = 'timed_out' AND suspension_generation > 0 AND error_class = 'blocker' AND error_code = 'suspension_expired' AND last_safe_error IS NOT NULL)),
  CHECK ((queue_state IN ('succeeded', 'failed', 'timed_out')) = (terminal_generation > 0)),
  CHECK ((queue_state IN ('succeeded', 'failed', 'timed_out')) = (completed_at IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (retention_deadline_at IS NULL OR (queue_state IN ('succeeded', 'failed', 'timed_out') AND retention_deadline_at >= resolved_at)),
  UNIQUE (command_id, run_id),
  UNIQUE (command_id, run_id, terminal_generation),
  UNIQUE (command_id, run_id, suspension_generation)
) STRICT;

CREATE TABLE career_stage_journal (
  stage_record_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  command_id TEXT NOT NULL REFERENCES career_commands(command_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_version INTEGER NOT NULL CHECK (stage_version > 0),
  state TEXT NOT NULL CHECK (state IN ('planned', 'applying', 'applied', 'outcome_unknown', 'reconciled', 'authorization_blocked', 'compensated')),
  safe_outcome TEXT NOT NULL DEFAULT 'not_started' CHECK (safe_outcome IN ('not_started', 'effect_verified', 'effect_absent', 'outcome_unknown', 'authorization_blocked', 'compensated')),
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_sheet_fingerprint TEXT CHECK (expected_sheet_fingerprint IS NULL OR (length(expected_sheet_fingerprint) = 71 AND substr(expected_sheet_fingerprint, 1, 7) = 'sha256:' AND substr(expected_sheet_fingerprint, 8) NOT GLOB '*[^0-9a-f]*')),
  expected_row_version INTEGER,
  external_reference TEXT,
  content_hash TEXT CHECK (content_hash IS NULL OR (length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:' AND substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*')),
  safe_result TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  resolved_at INTEGER,
  retention_deadline_at INTEGER,
  UNIQUE (command_id, stage_key, stage_version),
  FOREIGN KEY (command_id, run_id) REFERENCES career_commands(command_id, run_id) ON DELETE RESTRICT,
  CHECK ((state IN ('planned', 'applying') AND safe_outcome = 'not_started') OR (state = 'applied' AND safe_outcome = 'effect_verified') OR (state = 'outcome_unknown' AND safe_outcome = 'outcome_unknown') OR (state = 'reconciled' AND safe_outcome IN ('effect_verified', 'effect_absent')) OR (state = 'authorization_blocked' AND safe_outcome = 'authorization_blocked') OR (state = 'compensated' AND safe_outcome = 'compensated')),
  CHECK ((state IN ('planned', 'applying', 'outcome_unknown')) = (resolved_at IS NULL)),
  CHECK (retention_deadline_at IS NULL OR (resolved_at IS NOT NULL AND retention_deadline_at >= resolved_at))
) STRICT;

CREATE TABLE career_suspensions (
  suspension_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  command_id TEXT NOT NULL REFERENCES career_commands(command_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  suspended_step TEXT NOT NULL,
  blocker_kind TEXT NOT NULL CHECK (blocker_kind IN ('needs_browser_session', 'reauth_required', 'manual_intervention_required', 'browser_intervention_required', 'clarification_required')),
  blocker_state TEXT NOT NULL DEFAULT 'pending' CHECK (blocker_state IN ('pending', 'accepted', 'applying', 'applied', 'invalidated', 'expired')),
  blocker_schema_version INTEGER NOT NULL CHECK (blocker_schema_version = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  safe_payload TEXT NOT NULL CHECK (json_valid(safe_payload)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 71 AND substr(payload_hash, 1, 7) = 'sha256:' AND substr(payload_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 71 AND substr(source_hash, 1, 7) = 'sha256:' AND substr(source_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 71 AND substr(profile_hash, 1, 7) = 'sha256:' AND substr(profile_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  prompt_version INTEGER NOT NULL CHECK (prompt_version > 0),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 71 AND substr(prompt_hash, 1, 7) = 'sha256:' AND substr(prompt_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  resume_schema_version INTEGER NOT NULL CHECK (resume_schema_version = 1),
  resume_schema_hash TEXT NOT NULL CHECK (length(resume_schema_hash) = 71 AND substr(resume_schema_hash, 1, 7) = 'sha256:' AND substr(resume_schema_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  allowed_response TEXT NOT NULL CHECK (json_valid(allowed_response)),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  accepted_input_generation INTEGER,
  accepted_input_hash TEXT CHECK (accepted_input_hash IS NULL OR (length(accepted_input_hash) = 71 AND substr(accepted_input_hash, 1, 7) = 'sha256:' AND substr(accepted_input_hash, 8) NOT GLOB '*[^0-9a-f]*')),
  accepted_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  resolved_at INTEGER,
  retention_deadline_at INTEGER,
  UNIQUE (command_id, generation),
  UNIQUE (command_id, run_id, generation, suspension_id),
  FOREIGN KEY (command_id, run_id) REFERENCES career_commands(command_id, run_id) ON DELETE RESTRICT,
  CHECK ((blocker_state IN ('accepted', 'applying', 'applied')) = (accepted_input_generation IS NOT NULL AND accepted_input_hash IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (accepted_input_generation IS NULL OR accepted_input_generation = generation),
  CHECK (accepted_at IS NULL OR (accepted_at >= issued_at AND accepted_at < expires_at)),
  CHECK ((blocker_state IN ('pending', 'accepted', 'applying')) = (resolved_at IS NULL)),
  CHECK (retention_deadline_at IS NULL OR (resolved_at IS NOT NULL AND retention_deadline_at >= resolved_at))
) STRICT;

CREATE TABLE career_evidence_records (
  evidence_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  command_id TEXT NOT NULL REFERENCES career_commands(command_id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL,
  acquisition_method TEXT NOT NULL CHECK (acquisition_method IN ('direct_fetch', 'browser')),
  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
  bounded_spans TEXT NOT NULL CHECK (json_valid(bounded_spans)),
  bounded_excerpts TEXT NOT NULL CHECK (json_valid(bounded_excerpts)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 71 AND substr(source_hash, 1, 7) = 'sha256:' AND substr(source_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  source_version TEXT NOT NULL,
  profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 71 AND substr(profile_hash, 1, 7) = 'sha256:' AND substr(profile_hash, 8) NOT GLOB '*[^0-9a-f]*'),
  profile_version TEXT NOT NULL,
  retention_deadline_at INTEGER NOT NULL CHECK (retention_deadline_at >= acquired_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE career_completion_outbox (
  envelope_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  command_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  envelope_kind TEXT NOT NULL CHECK (envelope_kind IN ('suspension', 'terminal')),
  terminal_generation INTEGER,
  suspension_generation INTEGER,
  suspension_id TEXT,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'rendered', 'sending', 'delivered', 'retry_wait', 'blocked', 'send_unknown', 'dead_letter')),
  rendered_bytes BLOB,
  rendered_hash TEXT CHECK (rendered_hash IS NULL OR (length(rendered_hash) = 71 AND substr(rendered_hash, 1, 7) = 'sha256:' AND substr(rendered_hash, 8) NOT GLOB '*[^0-9a-f]*')),
  delivery_key TEXT UNIQUE,
  claim_owner TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_expires_at INTEGER,
  heartbeat_at INTEGER,
  retry_due_at INTEGER,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  delivered_at INTEGER,
  resolved_at INTEGER,
  retention_deadline_at INTEGER,
  CHECK ((envelope_kind = 'terminal' AND terminal_generation IS NOT NULL AND terminal_generation > 0 AND suspension_generation IS NULL AND suspension_id IS NULL) OR (envelope_kind = 'suspension' AND terminal_generation IS NULL AND suspension_generation IS NOT NULL AND suspension_generation > 0 AND suspension_id IS NOT NULL)),
  CHECK (json_extract(envelope_json, '$.schemaVersion') IS 1),
  CHECK (json_extract(envelope_json, '$.envelopeId') IS envelope_id),
  CHECK (json_extract(envelope_json, '$.commandId') IS command_id),
  CHECK (json_extract(envelope_json, '$.runId') IS run_id),
  CHECK (json_extract(envelope_json, '$.envelopeKind') IS envelope_kind),
  CHECK ((envelope_kind = 'terminal' AND json_extract(envelope_json, '$.terminalGeneration') IS terminal_generation AND json_type(envelope_json, '$.suspensionGeneration') IS 'null' AND json_type(envelope_json, '$.blocker') IS 'null') OR (envelope_kind = 'suspension' AND json_extract(envelope_json, '$.suspensionGeneration') IS suspension_generation AND json_type(envelope_json, '$.terminalGeneration') IS 'null' AND json_extract(envelope_json, '$.blocker.blockerId') IS suspension_id)),
  UNIQUE (envelope_id, command_id, run_id),
  UNIQUE (command_id, run_id, envelope_kind, terminal_generation, suspension_generation),
  FOREIGN KEY (command_id, run_id) REFERENCES career_commands(command_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, run_id, terminal_generation) REFERENCES career_commands(command_id, run_id, terminal_generation) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, run_id, suspension_generation) REFERENCES career_commands(command_id, run_id, suspension_generation) ON DELETE RESTRICT,
  FOREIGN KEY (command_id, run_id, suspension_generation, suspension_id) REFERENCES career_suspensions(command_id, run_id, generation, suspension_id) ON DELETE RESTRICT,
  CHECK ((rendered_bytes IS NULL) = (rendered_hash IS NULL)),
  CHECK (state NOT IN ('pending', 'claimed', 'blocked') OR rendered_bytes IS NULL),
  CHECK (state IN ('pending', 'claimed', 'blocked') OR rendered_bytes IS NOT NULL),
  CHECK ((claim_owner IS NULL AND claim_expires_at IS NULL AND heartbeat_at IS NULL) OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL AND claim_generation > 0)),
  CHECK ((state IN ('claimed', 'sending')) = (claim_owner IS NOT NULL)),
  CHECK ((state = 'retry_wait') = (retry_due_at IS NOT NULL)),
  CHECK ((state IN ('delivered', 'dead_letter')) = (resolved_at IS NOT NULL)),
  CHECK (retention_deadline_at IS NULL OR (state IN ('delivered', 'dead_letter') AND resolved_at IS NOT NULL AND retention_deadline_at >= resolved_at))
) STRICT;

CREATE TABLE career_deliveries (
  delivery_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('completion', 'turn')),
  envelope_id TEXT REFERENCES career_completion_outbox(envelope_id) ON DELETE RESTRICT,
  turn_delivery_id TEXT,
  source_command_id TEXT REFERENCES career_commands(command_id) ON DELETE RESTRICT,
  source_run_id TEXT,
  delivery_key TEXT NOT NULL UNIQUE,
  destination_channel TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  owner_resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  origin_channel TEXT NOT NULL,
  origin_destination TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'rendered', 'sending', 'delivered', 'retry_wait', 'blocked', 'send_unknown', 'dead_letter')),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_owner TEXT,
  claim_expires_at INTEGER,
  heartbeat_at INTEGER,
  rendered_bytes BLOB,
  rendered_hash TEXT CHECK (rendered_hash IS NULL OR (length(rendered_hash) = 71 AND substr(rendered_hash, 1, 7) = 'sha256:' AND substr(rendered_hash, 8) NOT GLOB '*[^0-9a-f]*')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at INTEGER,
  next_attempt_at INTEGER,
  retry_deadline_at INTEGER NOT NULL CHECK (retry_deadline_at >= created_at),
  provider TEXT CHECK (provider IS NULL OR provider IN ('telegram', 'studio', 'stdio')),
  provider_outcome TEXT CHECK (provider_outcome IS NULL OR provider_outcome IN ('acknowledged', 'definite_failure', 'unknown')),
  provider_message_id TEXT,
  provider_observed_at INTEGER,
  last_safe_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  delivered_at INTEGER,
  resolved_at INTEGER,
  retention_deadline_at INTEGER,
  CHECK ((source_kind = 'completion' AND envelope_id IS NOT NULL AND turn_delivery_id IS NULL AND source_command_id IS NOT NULL AND source_run_id IS NOT NULL) OR (source_kind = 'turn' AND envelope_id IS NULL AND turn_delivery_id IS NOT NULL AND source_command_id IS NULL AND source_run_id IS NULL)),
  FOREIGN KEY (envelope_id, source_command_id, source_run_id) REFERENCES career_completion_outbox(envelope_id, command_id, run_id) ON DELETE RESTRICT,
  CHECK ((claim_owner IS NULL AND claim_expires_at IS NULL AND heartbeat_at IS NULL) OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL AND claim_generation > 0)),
  CHECK ((state IN ('claimed', 'sending')) = (claim_owner IS NOT NULL)),
  CHECK ((rendered_bytes IS NULL) = (rendered_hash IS NULL)),
  CHECK (state NOT IN ('pending', 'claimed', 'blocked') OR rendered_bytes IS NULL),
  CHECK (state IN ('pending', 'claimed', 'blocked') OR rendered_bytes IS NOT NULL),
  CHECK ((attempt_count = 0) = (first_attempt_at IS NULL)),
  CHECK (state NOT IN ('sending', 'delivered', 'retry_wait', 'send_unknown', 'dead_letter') OR attempt_count > 0),
  CHECK ((provider IS NULL AND provider_outcome IS NULL AND provider_message_id IS NULL AND provider_observed_at IS NULL) OR (provider IS NOT NULL AND provider_outcome IS NOT NULL AND provider_observed_at IS NOT NULL AND (provider_outcome = 'acknowledged' OR provider_message_id IS NULL))),
  CHECK (state NOT IN ('pending', 'claimed', 'rendered', 'sending', 'blocked') OR provider_outcome IS NULL),
  CHECK (state <> 'delivered' OR (provider_outcome = 'acknowledged' AND provider_message_id IS NOT NULL AND delivered_at IS NOT NULL)),
  CHECK (state <> 'send_unknown' OR (provider_outcome IS NOT NULL AND provider_outcome = 'unknown')),
  CHECK (state NOT IN ('retry_wait', 'dead_letter') OR (provider_outcome IS NOT NULL AND provider_outcome = 'definite_failure')),
  CHECK ((state = 'retry_wait') = (next_attempt_at IS NOT NULL)),
  CHECK ((state IN ('delivered', 'dead_letter')) = (resolved_at IS NOT NULL)),
  CHECK (retention_deadline_at IS NULL OR (state IN ('delivered', 'dead_letter') AND resolved_at IS NOT NULL AND retention_deadline_at >= resolved_at))
) STRICT;

CREATE TABLE career_turn_inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('user', 'blocker', 'completion', 'ordinary_reply')),
  owner_resource_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  safe_payload TEXT NOT NULL CHECK (json_valid(safe_payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'delivered', 'failed')),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  delivered_at INTEGER,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL AND lease_generation > 0)),
  CHECK ((state = 'claimed') = (lease_owner IS NOT NULL))
) STRICT;

CREATE TABLE career_structured_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_kind TEXT NOT NULL,
  owner_resource_id TEXT,
  command_id TEXT REFERENCES career_commands(command_id) ON DELETE SET NULL,
  safe_fields TEXT NOT NULL CHECK (json_valid(safe_fields)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  retention_deadline_at INTEGER NOT NULL CHECK (retention_deadline_at >= occurred_at)
) STRICT;

CREATE TABLE career_deletion_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  owner_resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
) STRICT;

CREATE INDEX career_commands_fifo_idx ON career_commands(queue_state, queue_sequence);
CREATE INDEX career_commands_retry_due_idx ON career_commands(retry_due_at, queue_sequence) WHERE queue_state = 'retry_wait';
CREATE INDEX career_commands_lease_expiry_idx ON career_commands(lease_expires_at, queue_sequence) WHERE lease_owner IS NOT NULL;
CREATE INDEX career_commands_retention_idx ON career_commands(retention_deadline_at, queue_sequence) WHERE retention_deadline_at IS NOT NULL;
CREATE INDEX career_stage_state_idx ON career_stage_journal(state, updated_at);
CREATE INDEX career_stage_retention_idx ON career_stage_journal(retention_deadline_at, stage_record_id) WHERE retention_deadline_at IS NOT NULL;
CREATE INDEX career_suspensions_expiry_idx ON career_suspensions(expires_at, command_id) WHERE blocker_state IN ('pending', 'accepted', 'applying');
CREATE INDEX career_suspensions_retention_idx ON career_suspensions(retention_deadline_at, suspension_id) WHERE retention_deadline_at IS NOT NULL;
CREATE INDEX career_evidence_retention_idx ON career_evidence_records(retention_deadline_at, evidence_id);
CREATE UNIQUE INDEX career_outbox_terminal_generation_uidx ON career_completion_outbox(command_id, run_id, terminal_generation) WHERE envelope_kind = 'terminal';
CREATE UNIQUE INDEX career_outbox_suspension_generation_uidx ON career_completion_outbox(command_id, run_id, suspension_generation) WHERE envelope_kind = 'suspension';
CREATE INDEX career_outbox_pending_delivery_idx ON career_completion_outbox(state, retry_due_at, created_at, envelope_id);
CREATE INDEX career_outbox_lease_expiry_idx ON career_completion_outbox(claim_expires_at, envelope_id) WHERE claim_owner IS NOT NULL;
CREATE INDEX career_outbox_retention_idx ON career_completion_outbox(retention_deadline_at, envelope_id) WHERE retention_deadline_at IS NOT NULL;
CREATE INDEX career_deliveries_destination_idx ON career_deliveries(destination_channel, destination_id, created_at);
CREATE INDEX career_deliveries_due_work_idx ON career_deliveries(state, next_attempt_at, created_at, delivery_id);
CREATE INDEX career_deliveries_claim_expiry_idx ON career_deliveries(claim_expires_at, delivery_id) WHERE claim_owner IS NOT NULL;
CREATE INDEX career_deliveries_retention_idx ON career_deliveries(retention_deadline_at, delivery_id) WHERE retention_deadline_at IS NOT NULL;
CREATE INDEX career_turn_inbox_fifo_idx ON career_turn_inbox(state, sequence);
CREATE INDEX career_turn_inbox_lease_expiry_idx ON career_turn_inbox(lease_expires_at, sequence) WHERE lease_owner IS NOT NULL;
CREATE INDEX career_structured_events_retention_idx ON career_structured_events(retention_deadline_at, event_id);

CREATE TRIGGER career_commands_queue_sequence_database_assigned
BEFORE INSERT ON career_commands
WHEN NEW.queue_sequence <> -1
BEGIN
  SELECT RAISE(ABORT, 'queue_sequence is database-assigned');
END;

CREATE TRIGGER career_outbox_rendering_immutable
BEFORE UPDATE OF rendered_bytes, rendered_hash ON career_completion_outbox
WHEN OLD.rendered_bytes IS NOT NULL AND (OLD.rendered_bytes IS NOT NEW.rendered_bytes OR OLD.rendered_hash IS NOT NEW.rendered_hash)
BEGIN
  SELECT RAISE(ABORT, 'rendered delivery is immutable');
END;

CREATE TRIGGER career_delivery_rendering_immutable
BEFORE UPDATE OF rendered_bytes, rendered_hash ON career_deliveries
WHEN OLD.rendered_bytes IS NOT NULL AND (OLD.rendered_bytes IS NOT NEW.rendered_bytes OR OLD.rendered_hash IS NOT NEW.rendered_hash)
BEGIN
  SELECT RAISE(ABORT, 'rendered delivery is immutable');
END;

CREATE TRIGGER career_inbound_transport_identity_immutable
BEFORE UPDATE OF channel, transport_event_id ON career_inbound_events
WHEN OLD.channel <> NEW.channel OR OLD.transport_event_id <> NEW.transport_event_id
BEGIN
  SELECT RAISE(ABORT, 'transport event identity is immutable');
END;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: 'legacy_idempotency_compatibility', sql: legacyCompatibilitySql, checksum: '606b96f6bea28639b2f8699634873cfeb02a1f6ef549bc0b676e2f6c7a8cbd28' }),
  Object.freeze({ version: 2, name: 'durable_v0_records', sql: durableRecordsSql, checksum: '0ba6f834821ae214eb0c168c89417f4a66faf03d0c205cb79ab87ff7182b8617' }),
]);

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
    legacy_outbox_preserved INTEGER NOT NULL CHECK (legacy_outbox_preserved IN (0, 1) AND (version = 1 OR legacy_outbox_preserved = 0))
  ) STRICT;
`;

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };

function normalizedSql(sql: string | null): string {
  let normalized = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let pendingSpace = false;
  const source = sql ?? '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      normalized += character;
      if (character === quote) {
        if (quote !== ']' && source[index + 1] === quote) normalized += source[++index];
        else quote = null;
      }
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += ' ';
    pendingSpace = false;
    normalized += character;
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '[') quote = ']';
  }
  return normalized;
}

function schemaObjects(database: DatabaseSync, ownedOnly: boolean): SchemaObject[] {
  const where = ownedOnly
    ? "name = 'schema_migrations' OR name LIKE 'career_%' OR tbl_name LIKE 'career_%'"
    : "name NOT LIKE 'sqlite_%'";
  return database.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE ${where} ORDER BY type, name`).all() as SchemaObject[];
}

function isAllowedLegacyOutboxObject(object: SchemaObject): boolean {
  return (object.type === 'table' && object.name === 'career_outbox')
    || (object.type === 'index' && object.tbl_name === 'career_outbox' && object.sql === null && object.name.startsWith('sqlite_autoindex_career_outbox_'));
}

function sameSchema(actual: SchemaObject[], expected: SchemaObject[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => {
    const wanted = expected[index];
    return item.type === wanted.type && item.name === wanted.name && item.tbl_name === wanted.tbl_name && normalizedSql(item.sql) === normalizedSql(wanted.sql);
  });
}

type LedgerRow = { version: number; name: string; checksum: string; legacy_outbox_preserved: number };

function verifyLedger(rows: LedgerRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = MIGRATIONS[index];
    if (!expected || row.version !== expected.version) throw new Error(`Unsupported schema migration version ${row.version}.`);
    if (row.name !== expected.name || row.checksum !== expected.checksum) throw new Error(`Schema migration checksum drift at version ${row.version}.`);
    if ((row.legacy_outbox_preserved !== 0 && row.legacy_outbox_preserved !== 1) || (row.version !== 1 && row.legacy_outbox_preserved !== 0)) {
      throw new Error(`Invalid legacy outbox provenance at schema migration version ${row.version}.`);
    }
  }
}

function expectedSchema(version: number, includeLegacyOutbox: boolean): SchemaObject[] {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(legacyBaselineSql);
    expected.exec(LEDGER_SQL);
    if (version >= 1) expected.exec(legacyCompatibilitySql);
    if (version >= 2) expected.exec(durableRecordsSql);
    const objects = schemaObjects(expected, true);
    return includeLegacyOutbox ? objects : objects.filter((object) => !isAllowedLegacyOutboxObject(object));
  } finally {
    expected.close();
  }
}

function verifyInstalledSchema(database: DatabaseSync, version: number, legacyOutboxPreserved: boolean): void {
  const actual = schemaObjects(database, true);
  const expected = expectedSchema(version, legacyOutboxPreserved);
  if (!sameSchema(actual, expected)) {
    const mismatch = actual.find((item, index) => {
      const wanted = expected[index];
      return !wanted || item.type !== wanted.type || item.name !== wanted.name || item.tbl_name !== wanted.tbl_name || normalizedSql(item.sql) !== normalizedSql(wanted.sql);
    }) ?? expected[actual.length];
    throw new Error(`Installed schema verification failed for ${mismatch?.type ?? 'owned'} ${mismatch?.name ?? 'schema'}.`);
  }
}

function recognizeUnledgered(database: DatabaseSync): 'empty' | 'legacy' {
  const actual = schemaObjects(database, true);
  if (actual.length === 0) return 'empty';
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(legacyBaselineSql);
    if (sameSchema(actual, schemaObjects(expected, true))) return 'legacy';
  } finally {
    expected.close();
  }
  throw new Error('Unrecognized unledgered operational database schema; refusing to mutate it.');
}

function ledgerExists(database: DatabaseSync): boolean {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get() !== undefined;
}

function inspectBeforeMutation(database: DatabaseSync): void {
  if (!ledgerExists(database)) {
    recognizeUnledgered(database);
    return;
  }
  const rows = database.prepare('SELECT version, name, checksum, legacy_outbox_preserved FROM schema_migrations ORDER BY version').all() as LedgerRow[];
  verifyLedger(rows);
  if (rows.length === 0) throw new Error('Unsupported empty schema migration ledger.');
  verifyInstalledSchema(database, rows.length, rows[0].legacy_outbox_preserved === 1);
}

export function normalizeJobIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function buildJobIdempotencyKey(identity: JobIdentity): string {
  if (identity.url?.trim()) return `url:${canonicalUrl(identity.url)}`;
  const values = [identity.company, identity.title, identity.location].map((value) => normalizeJobIdentity(value ?? ''));
  if (values.every(Boolean)) return `identity:${values.join('|')}`;
  throw new Error('A URL or complete company, title, and location identity is required.');
}

export class CareerStore {
  private readonly database: DatabaseSync;
  private readonly leaseMs: number;
  private migrationsVerified = false;

  constructor(databaseUrl: string, options: { leaseMs?: number } = {}) {
    const verifiedUrl = assertOperationalDatabaseUrl(databaseUrl);
    this.leaseMs = options.leaseMs ?? 60_000;
    this.database = new DatabaseSync(fileURLToPath(verifiedUrl));
    try {
      this.verifyCommittedChecksums();
      this.database.exec('PRAGMA busy_timeout = 5000;');
      this.database.exec('BEGIN');
      try {
        inspectBeforeMutation(this.database);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      this.database.exec('PRAGMA foreign_keys = ON;');
      let journalMode: { journal_mode: string } | undefined;
      try {
        journalMode = this.database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        // ponytail: one WAL-only retry; persistent contention still fails startup closed.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        journalMode = this.database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
      }
      if (journalMode.journal_mode.toLowerCase() !== 'wal') throw new Error('Operational database journal mode verification failed.');
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private verifyCommittedChecksums(): void {
    for (const migration of MIGRATIONS) {
      const actualChecksum = createHash('sha256').update(migration.sql).digest('hex');
      if (actualChecksum !== migration.checksum) throw new Error(`Committed migration checksum mismatch for version ${migration.version}.`);
    }
  }

  private migrate(): void {
    while (!this.migrationsVerified) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        if (!ledgerExists(this.database)) {
          const baseline = recognizeUnledgered(this.database);
          if (baseline === 'empty') this.database.exec(emptyCompatibilityBaselineSql);
          this.database.exec(LEDGER_SQL);
          const migration = MIGRATIONS[0];
          this.database.exec(migration.sql);
          this.database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at, legacy_outbox_preserved) VALUES (?, ?, ?, ?, ?)').run(migration.version, migration.name, migration.checksum, Date.now(), baseline === 'legacy' ? 1 : 0);
          this.database.exec('COMMIT');
          continue;
        }

        const applied = this.database.prepare('SELECT version, name, checksum, legacy_outbox_preserved FROM schema_migrations ORDER BY version').all() as LedgerRow[];
        verifyLedger(applied);
        if (applied.length === MIGRATIONS.length) {
          verifyInstalledSchema(this.database, applied.length, applied[0].legacy_outbox_preserved === 1);
          if ((this.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1) throw new Error('Installed schema verification failed: foreign keys are disabled.');
          this.database.exec('COMMIT');
          this.migrationsVerified = true;
          continue;
        }
        if (applied.length === 0) throw new Error('Unsupported empty schema migration ledger.');
        verifyInstalledSchema(this.database, applied.length, applied[0].legacy_outbox_preserved === 1);
        const migration = MIGRATIONS[applied.length];
        this.database.exec(migration.sql);
        this.database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at, legacy_outbox_preserved) VALUES (?, ?, ?, ?, 0)').run(migration.version, migration.name, migration.checksum, Date.now());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  migrationStatus(): { currentVersion: number; verified: boolean } {
    return { currentVersion: MIGRATIONS.length, verified: this.migrationsVerified };
  }

  async claimRequest(requestId: string): Promise<boolean> {
    const result = this.database.prepare('INSERT INTO career_requests (request_id) VALUES (?) ON CONFLICT(request_id) DO NOTHING').run(requestId);
    return Number(result.changes) === 1;
  }

  async claim(key: string, requestId: string): Promise<{ claimed: boolean; record: IdempotencyRecord }> {
    const now = Date.now();
    const leaseUntil = now + this.leaseMs;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT state, lease_until FROM career_idempotency WHERE key = ?').get(key) as { state: JobState; lease_until: number | null } | undefined;
      let claimed = false;
      if (!current) {
        this.database.prepare("INSERT INTO career_idempotency (key, first_request_id, state, lease_until) VALUES (?, ?, 'pending', ?)").run(key, requestId, leaseUntil);
        claimed = true;
      } else if (current.state === 'succeeded') {
        claimed = false;
      } else if (current.state === 'pending' && current.lease_until !== null && current.lease_until > now) {
        claimed = false;
      } else {
        this.database.prepare("UPDATE career_idempotency SET state = 'pending', lease_until = ?, last_request_id = ?, error = NULL WHERE key = ?").run(leaseUntil, requestId, key);
        claimed = true;
      }
      this.database.exec('COMMIT');
      return { claimed, record: this.get(key)! };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async markSucceeded(key: string, requestId: string): Promise<void> {
    const result = this.database.prepare("UPDATE career_idempotency SET state = 'succeeded', lease_until = NULL, last_request_id = ? WHERE key = ? AND state = 'pending'").run(requestId, key);
    if (Number(result.changes) !== 1) throw new Error('Cannot mark an unclaimed job as succeeded.');
  }

  async markFailed(key: string, requestId: string, errorCode?: string): Promise<void> {
    const safeCode = errorCode === 'job_processing_failed' ? errorCode : null;
    this.database.prepare("UPDATE career_idempotency SET state = 'failed', lease_until = NULL, last_request_id = ?, error = ? WHERE key = ? AND state = 'pending'").run(requestId, safeCode, key);
  }

  getState(key: string): { state: JobState; leaseUntil: number | null; error?: string } | undefined {
    const row = this.database.prepare('SELECT state, lease_until AS leaseUntil, error FROM career_idempotency WHERE key = ?').get(key) as { state: JobState; leaseUntil: number | null; error: string | null } | undefined;
    return row ? { state: row.state, leaseUntil: row.leaseUntil, ...(row.error === null ? {} : { error: row.error }) } : undefined;
  }

  async recordSighting(key: string, requestId: string, sourceId: string): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO career_idempotency (key, first_request_id, sightings, last_request_id, last_source_id, state)
        VALUES (?, ?, 1, ?, ?, 'failed')
        ON CONFLICT(key) DO UPDATE SET sightings = career_idempotency.sightings + 1, last_request_id = excluded.last_request_id, last_source_id = excluded.last_source_id
      `).run(key, requestId, requestId, sourceId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(key: string): IdempotencyRecord | undefined {
    const row = this.database.prepare('SELECT key, first_request_id AS firstRequestId, sightings, last_request_id AS lastRequestId, last_source_id AS lastSourceId FROM career_idempotency WHERE key = ?').get(key) as IdempotencyRecord | undefined;
    return row ? { ...row } : undefined;
  }

  close(): void {
    this.database.close();
  }
}
