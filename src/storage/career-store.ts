import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { assertCurrentlyValidPrincipalAuthorizationCapability, isOwnerAuthorizationCapability, type OwnerAuthorizationCapability } from '../channels/telegram-auth.ts';
import { assertOperationalDatabaseUrl } from '../config/runtime.ts';
import type { QueueStateV0 } from '../contracts/v0.ts';
import { STAGE_REPEAT_CAPS, classifyFailure, computeRetrySchedule, type FailureClass, type RetryPolicyResult, type RetryStage, type SafeFailureCode } from '../workflows/retry-policy.ts';

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

const task4CommandTableSql = durableRecordsSql
  .slice(durableRecordsSql.indexOf('CREATE TABLE career_commands'), durableRecordsSql.indexOf('\n\nCREATE TABLE career_stage_journal'))
  .replace(
    "CHECK ((queue_state IN ('suspended', 'resuming')) = (suspension_generation > 0 AND blocker_id IS NOT NULL)),\n  CHECK ((blocker_id IS NOT NULL) = (queue_state IN ('suspended', 'resuming'))),",
    "CHECK (queue_state <> 'suspended' OR (suspension_generation > 0 AND blocker_id IS NOT NULL)),\n  CHECK (queue_state <> 'resuming' OR (blocker_id IS NULL OR suspension_generation > 0)),\n  CHECK (queue_state IN ('suspended', 'resuming') OR blocker_id IS NULL),",
  );

const queueFencingSql = `
PRAGMA legacy_alter_table = ON;
ALTER TABLE career_commands RENAME TO career_commands_task3;
${task4CommandTableSql}
INSERT INTO career_commands SELECT * FROM career_commands_task3;
DROP TABLE career_commands_task3;
CREATE INDEX career_commands_fifo_idx ON career_commands(queue_state, queue_sequence);
CREATE INDEX career_commands_retry_due_idx ON career_commands(retry_due_at, queue_sequence) WHERE queue_state = 'retry_wait';
CREATE INDEX career_commands_lease_expiry_idx ON career_commands(lease_expires_at, queue_sequence) WHERE lease_owner IS NOT NULL;
CREATE INDEX career_commands_retention_idx ON career_commands(retention_deadline_at, queue_sequence) WHERE retention_deadline_at IS NOT NULL;
CREATE TRIGGER career_commands_queue_sequence_database_assigned
BEFORE INSERT ON career_commands
WHEN NEW.queue_sequence <> -1
BEGIN
  SELECT RAISE(ABORT, 'queue_sequence is database-assigned');
END;
CREATE TRIGGER career_commands_legal_queue_transition
BEFORE UPDATE OF queue_state ON career_commands
WHEN OLD.queue_state <> NEW.queue_state AND NOT (
  (OLD.queue_state = 'queued' AND NEW.queue_state = 'starting') OR
  (OLD.queue_state = 'starting' AND NEW.queue_state IN ('running', 'timed_out')) OR
  (OLD.queue_state = 'running' AND NEW.queue_state IN ('retry_wait', 'suspended', 'succeeded', 'failed', 'timed_out')) OR
  (OLD.queue_state = 'retry_wait' AND NEW.queue_state IN ('resuming', 'timed_out')) OR
  (OLD.queue_state = 'suspended' AND NEW.queue_state IN ('resuming', 'timed_out')) OR
  (OLD.queue_state = 'resuming' AND NEW.queue_state IN ('running', 'timed_out'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal queue transition');
END;
CREATE TRIGGER career_commands_terminal_immutable
BEFORE UPDATE ON career_commands
WHEN OLD.queue_state IN ('succeeded', 'failed', 'timed_out')
BEGIN
  SELECT RAISE(ABORT, 'terminal command is immutable');
END;
PRAGMA legacy_alter_table = OFF;
`;

const retryPolicySql = `
ALTER TABLE career_commands ADD COLUMN automatic_repeats_used INTEGER NOT NULL DEFAULT 0 CHECK (automatic_repeats_used BETWEEN 0 AND 5 AND automatic_repeats_used + repeat_budget_remaining = 5);
ALTER TABLE career_commands ADD COLUMN processing_budget_remaining_ms INTEGER NOT NULL DEFAULT 1800000 CHECK (processing_budget_remaining_ms BETWEEN 0 AND 1800000);
ALTER TABLE career_commands ADD COLUMN suspension_started_at INTEGER CHECK (suspension_started_at IS NULL OR suspension_started_at >= processing_started_at);
ALTER TABLE career_commands ADD COLUMN legacy_retry_wait_v4 INTEGER NOT NULL DEFAULT 0 CHECK (legacy_retry_wait_v4 IN (0, 1) AND (legacy_retry_wait_v4 = 0 OR queue_state = 'retry_wait'));
UPDATE career_commands SET legacy_retry_wait_v4 = 1 WHERE queue_state = 'retry_wait';
CREATE TABLE career_v5_backfill_guard (valid INTEGER NOT NULL CHECK (valid = 1)) STRICT;
INSERT INTO career_v5_backfill_guard
SELECT CASE WHEN count(*) = 0 THEN 1 ELSE 0 END FROM career_commands
WHERE queue_state IN ('starting','running','retry_wait','resuming') AND (processing_deadline_at IS NULL OR updated_at IS NULL)
   OR queue_state = 'suspended' AND (processing_started_at IS NULL OR updated_at IS NULL OR updated_at < processing_started_at);
UPDATE career_commands SET
  processing_budget_remaining_ms = min(1800000, max(0, processing_deadline_at - updated_at)),
  processing_deadline_at = updated_at + min(1800000, max(0, processing_deadline_at - updated_at))
WHERE queue_state IN ('starting','running','retry_wait','resuming');
UPDATE career_commands SET processing_budget_remaining_ms = min(1800000, max(0, 1800000 - (updated_at - processing_started_at))),
  suspension_started_at = updated_at, processing_deadline_at = NULL
WHERE queue_state = 'suspended';
DROP TABLE career_v5_backfill_guard;
CREATE TABLE career_retry_schedules (
  command_id TEXT NOT NULL REFERENCES career_commands(command_id) ON DELETE RESTRICT CHECK (length(command_id) BETWEEN 1 AND 200),
  schedule_key TEXT NOT NULL CHECK (length(schedule_key) BETWEEN 1 AND 200),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  owner_resource_id TEXT NOT NULL CHECK (length(owner_resource_id) BETWEEN 1 AND 200),
  lease_owner TEXT NOT NULL CHECK (length(lease_owner) BETWEEN 1 AND 200),
  claim_generation INTEGER NOT NULL CHECK (claim_generation > 0),
  stage_key TEXT NOT NULL CHECK (stage_key IN ('direct_acquisition', 'browser_connection', 'provider_inference', 'schema_repair', 'external_effect')),
  stage_repeat INTEGER NOT NULL CHECK (stage_repeat BETWEEN 1 AND 2),
  automatic_repeat_ordinal INTEGER NOT NULL CHECK (automatic_repeat_ordinal BETWEEN 1 AND 5),
  policy_attempt INTEGER NOT NULL CHECK (policy_attempt > 0),
  policy_source TEXT NOT NULL CHECK (policy_source IN ('jitter', 'retry_after')),
  policy_calculated_at INTEGER NOT NULL CHECK (policy_calculated_at >= 0),
  policy_delay_ms INTEGER NOT NULL CHECK (policy_delay_ms >= 0),
  policy_target_at INTEGER NOT NULL CHECK (policy_target_at = policy_calculated_at + policy_delay_ms),
  retry_after_value TEXT CHECK (retry_after_value IS NULL OR length(retry_after_value) BETWEEN 1 AND 128),
  failure_class TEXT NOT NULL CHECK (failure_class IN ('transient', 'rate_limited')),
  failure_code TEXT NOT NULL CHECK (length(failure_code) BETWEEN 1 AND 64 AND failure_code NOT GLOB '*[^a-z0-9_]*'),
  safe_detail TEXT NOT NULL CHECK (
    (failure_code IN ('temporarily_unavailable', 'temporary', 'temporary_failure') AND safe_detail = 'The operation is temporarily unavailable.')
    OR (failure_code = 'invalid_shape' AND safe_detail = 'The schema needs repair.')
    OR (failure_code = 'network_unavailable' AND safe_detail = 'The network is unavailable.')
    OR (failure_code = 'rate_limited' AND safe_detail = 'The provider asked us to wait.')
    OR (failure_code = 'fixture_retry' AND safe_detail = 'The fixture operation is temporarily unavailable.')
  ),
  scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
  due_at INTEGER NOT NULL CHECK (due_at = max(scheduled_at, policy_target_at)),
  PRIMARY KEY (command_id, schedule_key),
  FOREIGN KEY (command_id, run_id) REFERENCES career_commands(command_id, run_id) ON DELETE RESTRICT,
  UNIQUE (command_id, stage_key, stage_repeat),
  UNIQUE (command_id, automatic_repeat_ordinal)
) STRICT;
CREATE INDEX career_retry_schedules_due_idx ON career_retry_schedules(due_at, command_id);
CREATE TRIGGER career_retry_schedules_insert_authority
BEFORE INSERT ON career_retry_schedules
WHEN COALESCE(NOT EXISTS (
  SELECT 1 FROM career_commands c WHERE c.command_id = NEW.command_id AND c.run_id = NEW.run_id
    AND c.owner_resource_id = NEW.owner_resource_id AND c.lease_owner = NEW.lease_owner
    AND c.claim_generation = NEW.claim_generation AND c.queue_state = 'running'
    AND c.lease_expires_at > NEW.scheduled_at AND c.processing_deadline_at > NEW.due_at
    AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND NEW.policy_calculated_at <= NEW.scheduled_at
    AND NEW.policy_target_at = NEW.policy_calculated_at + NEW.policy_delay_ms
    AND NEW.due_at = max(NEW.scheduled_at, NEW.policy_target_at)
    AND NEW.scheduled_at >= c.updated_at
    AND NEW.scheduled_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.automatic_repeats_used < 5
    AND NEW.automatic_repeat_ordinal = c.automatic_repeats_used + 1
    AND NEW.stage_repeat = (SELECT count(*) + 1 FROM career_retry_schedules r WHERE r.command_id = c.command_id AND r.stage_key = NEW.stage_key)
    AND NEW.policy_attempt = NEW.stage_repeat
    AND NEW.stage_repeat <= CASE NEW.stage_key
      WHEN 'direct_acquisition' THEN 2 WHEN 'browser_connection' THEN 2
      WHEN 'provider_inference' THEN 1 WHEN 'schema_repair' THEN 1 ELSE 0 END
    AND ((NEW.failure_class = 'transient' AND NEW.policy_source = 'jitter' AND NEW.retry_after_value IS NULL
          AND NEW.failure_code IN ('temporarily_unavailable','temporary','temporary_failure','invalid_shape','network_unavailable','fixture_retry')
          AND NEW.policy_delay_ms <= CASE WHEN NEW.policy_attempt = 1 THEN 2000 ELSE 4000 END)
      OR (NEW.failure_class = 'rate_limited' AND NEW.failure_code = 'rate_limited'
          AND NEW.policy_source = 'retry_after' AND NEW.retry_after_value IS NOT NULL
          AND ((NEW.retry_after_value NOT GLOB '*[^0-9]*'
                AND NEW.policy_delay_ms = CAST(NEW.retry_after_value AS INTEGER) * 1000)
            OR (NEW.retry_after_value GLOB '???, ?? ??? ???? ??:??:?? GMT'
              AND substr(NEW.retry_after_value,18,2) NOT GLOB '*[^0-9]*' AND CAST(substr(NEW.retry_after_value,18,2) AS INTEGER) BETWEEN 0 AND 23
              AND substr(NEW.retry_after_value,21,2) NOT GLOB '*[^0-9]*' AND CAST(substr(NEW.retry_after_value,21,2) AS INTEGER) BETWEEN 0 AND 59
              AND substr(NEW.retry_after_value,24,2) NOT GLOB '*[^0-9]*' AND CAST(substr(NEW.retry_after_value,24,2) AS INTEGER) BETWEEN 0 AND 59
              AND substr(NEW.retry_after_value,1,3) = CASE strftime('%w',
                substr(NEW.retry_after_value,13,4) || '-' || (CASE substr(NEW.retry_after_value,9,3)
                  WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
                  WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
                  WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END)
                  || '-' || substr(NEW.retry_after_value,6,2) || 'T' || substr(NEW.retry_after_value,18,8) || 'Z')
                WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue' WHEN '3' THEN 'Wed'
                WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' WHEN '6' THEN 'Sat' END
              AND strftime('%Y-%m-%dT%H:%M:%SZ',
                substr(NEW.retry_after_value,13,4) || '-' || (CASE substr(NEW.retry_after_value,9,3)
                  WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
                  WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
                  WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END)
                  || '-' || substr(NEW.retry_after_value,6,2) || 'T' || substr(NEW.retry_after_value,18,8) || 'Z')
                = substr(NEW.retry_after_value,13,4) || '-' || (CASE substr(NEW.retry_after_value,9,3)
                  WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
                  WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
                  WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END)
                  || '-' || substr(NEW.retry_after_value,6,2) || 'T' || substr(NEW.retry_after_value,18,8) || 'Z'
              AND NEW.policy_delay_ms = max(0, unixepoch(substr(NEW.retry_after_value,13,4) || '-' || (CASE substr(NEW.retry_after_value,9,3)
                WHEN 'Jan' THEN '01' WHEN 'Feb' THEN '02' WHEN 'Mar' THEN '03' WHEN 'Apr' THEN '04'
                WHEN 'May' THEN '05' WHEN 'Jun' THEN '06' WHEN 'Jul' THEN '07' WHEN 'Aug' THEN '08'
                WHEN 'Sep' THEN '09' WHEN 'Oct' THEN '10' WHEN 'Nov' THEN '11' WHEN 'Dec' THEN '12' END)
                || '-' || substr(NEW.retry_after_value,6,2) || 'T' || substr(NEW.retry_after_value,18,8) || 'Z') * 1000 - NEW.policy_calculated_at)))))
    AND ((NEW.failure_code = 'invalid_shape' AND NEW.stage_key = 'schema_repair')
      OR (NEW.failure_code = 'network_unavailable' AND NEW.stage_key IN ('direct_acquisition','browser_connection'))
      OR (NEW.failure_code = 'fixture_retry' AND NEW.stage_key = 'direct_acquisition')
      OR (NEW.failure_code IN ('temporarily_unavailable','rate_limited') AND NEW.stage_key IN ('direct_acquisition','browser_connection','provider_inference'))
      OR (NEW.failure_code IN ('temporary','temporary_failure') AND NEW.stage_key IN ('direct_acquisition','browser_connection','provider_inference','schema_repair')))
), 1)
BEGIN SELECT RAISE(ABORT, 'invalid retry schedule authority'); END;
CREATE TRIGGER career_retry_schedules_apply_authority
AFTER INSERT ON career_retry_schedules
BEGIN
  UPDATE career_commands SET queue_state = 'retry_wait', retry_due_at = NEW.due_at,
    automatic_repeats_used = automatic_repeats_used + 1, repeat_budget_remaining = repeat_budget_remaining - 1,
    processing_budget_remaining_ms = processing_deadline_at - NEW.scheduled_at,
    error_class = NEW.failure_class, error_code = NEW.failure_code, last_safe_error = NEW.safe_detail,
    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = NEW.scheduled_at
  WHERE command_id = NEW.command_id AND run_id = NEW.run_id AND owner_resource_id = NEW.owner_resource_id
    AND lease_owner = NEW.lease_owner AND claim_generation = NEW.claim_generation AND queue_state = 'running';
END;
CREATE TRIGGER career_retry_schedules_update_immutable BEFORE UPDATE ON career_retry_schedules BEGIN
  SELECT RAISE(ABORT, 'retry schedule is immutable');
END;
CREATE TRIGGER career_retry_schedules_delete_immutable BEFORE DELETE ON career_retry_schedules BEGIN
  SELECT RAISE(ABORT, 'retry schedule is immutable');
END;
CREATE TRIGGER career_commands_retry_budget_insert_guard
BEFORE INSERT ON career_commands
WHEN NEW.automatic_repeats_used <> 0 OR NEW.repeat_budget_remaining <> 5
BEGIN SELECT RAISE(ABORT, 'new command retry budget must be fresh'); END;
CREATE TRIGGER career_commands_retry_authority_guard
BEFORE UPDATE ON career_commands
WHEN (OLD.queue_state = 'running' AND NEW.queue_state = 'retry_wait') OR NEW.automatic_repeats_used <> OLD.automatic_repeats_used OR NEW.repeat_budget_remaining <> OLD.repeat_budget_remaining
BEGIN
  SELECT CASE WHEN NOT (
    OLD.queue_state = 'running' AND NEW.queue_state = 'retry_wait'
    AND NEW.automatic_repeats_used = OLD.automatic_repeats_used + 1
    AND NEW.repeat_budget_remaining = OLD.repeat_budget_remaining - 1
    AND EXISTS (SELECT 1 FROM career_retry_schedules r WHERE r.command_id = OLD.command_id
      AND r.run_id = OLD.run_id AND r.claim_generation = OLD.claim_generation
      AND r.automatic_repeat_ordinal = NEW.automatic_repeats_used AND r.due_at = NEW.retry_due_at
      AND r.scheduled_at = NEW.updated_at)
  ) THEN RAISE(ABORT, 'retry transition requires schedule authority') END;
END;
CREATE TRIGGER career_commands_processing_time_authority
BEFORE UPDATE ON career_commands
WHEN NOT (NEW.processing_started_at IS OLD.processing_started_at)
  OR NOT (NEW.processing_deadline_at IS OLD.processing_deadline_at)
  OR NEW.processing_budget_remaining_ms <> OLD.processing_budget_remaining_ms
  OR NOT (NEW.suspension_started_at IS OLD.suspension_started_at)
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.queue_state = 'queued' AND NEW.queue_state = 'starting'
      AND OLD.processing_started_at IS NULL AND NEW.processing_started_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.updated_at = NEW.processing_started_at
      AND NEW.processing_deadline_at = NEW.processing_started_at + NEW.processing_budget_remaining_ms
      AND NEW.processing_budget_remaining_ms BETWEEN 1 AND 1800000 AND NEW.suspension_started_at IS NULL)
    OR (OLD.queue_state = 'running' AND NEW.queue_state = 'retry_wait'
      AND NEW.processing_started_at = OLD.processing_started_at AND NEW.processing_deadline_at = OLD.processing_deadline_at
      AND NEW.processing_budget_remaining_ms = OLD.processing_deadline_at - NEW.updated_at AND NEW.suspension_started_at IS NULL
      AND EXISTS (SELECT 1 FROM career_retry_schedules r WHERE r.command_id = OLD.command_id
        AND r.automatic_repeat_ordinal = NEW.automatic_repeats_used AND r.scheduled_at = NEW.updated_at))
    OR (OLD.queue_state = 'running' AND NEW.queue_state = 'suspended'
      AND NEW.processing_started_at = OLD.processing_started_at
      AND OLD.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.claim_generation = OLD.claim_generation AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.processing_deadline_at IS NULL
      AND NEW.processing_budget_remaining_ms = OLD.processing_deadline_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.suspension_started_at = CAST(unixepoch('subsec') * 1000 AS INTEGER))
    OR (OLD.queue_state = 'suspended' AND NEW.queue_state = 'resuming'
      AND NEW.processing_started_at = OLD.processing_started_at AND OLD.processing_budget_remaining_ms > 0
      AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms
      AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.processing_deadline_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + OLD.processing_budget_remaining_ms
      AND NEW.suspension_started_at IS NULL AND NEW.claim_generation = OLD.claim_generation + 1
      AND NEW.lease_owner IS NOT NULL AND NEW.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      AND NEW.heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ) THEN RAISE(ABORT, 'processing time mutation is unauthorized') END;
END;
CREATE TRIGGER career_commands_legacy_retry_wait_insert_guard
BEFORE INSERT ON career_commands WHEN NEW.legacy_retry_wait_v4 <> 0
BEGIN SELECT RAISE(ABORT, 'legacy retry wait marker is migration-owned'); END;
CREATE TRIGGER career_commands_legacy_retry_wait_marker_guard
BEFORE UPDATE OF legacy_retry_wait_v4 ON career_commands
WHEN NEW.legacy_retry_wait_v4 <> OLD.legacy_retry_wait_v4 AND NOT (
  OLD.legacy_retry_wait_v4 = 1 AND NEW.legacy_retry_wait_v4 = 0
  AND OLD.queue_state = 'retry_wait' AND NEW.queue_state IN ('resuming', 'timed_out')
)
BEGIN SELECT RAISE(ABORT, 'legacy retry wait marker is migration-owned'); END;
CREATE TRIGGER career_commands_retry_wait_projection_authority
BEFORE UPDATE ON career_commands
WHEN OLD.queue_state = 'retry_wait'
BEGIN
  SELECT CASE WHEN NOT (
    (OLD.legacy_retry_wait_v4 = 0 AND NEW.legacy_retry_wait_v4 = 0
      AND EXISTS (SELECT 1 FROM career_retry_schedules r WHERE r.command_id = OLD.command_id
        AND r.automatic_repeat_ordinal = OLD.automatic_repeats_used AND r.due_at = OLD.retry_due_at
        AND r.failure_class = OLD.error_class AND r.failure_code = OLD.error_code AND r.safe_detail = OLD.last_safe_error
        AND OLD.processing_budget_remaining_ms = OLD.processing_deadline_at - r.scheduled_at)
      AND (
        (NEW.queue_state = 'retry_wait' AND NEW.retry_due_at = OLD.retry_due_at
          AND NEW.automatic_repeats_used = OLD.automatic_repeats_used AND NEW.repeat_budget_remaining = OLD.repeat_budget_remaining
          AND NEW.error_class = OLD.error_class AND NEW.error_code = OLD.error_code AND NEW.last_safe_error = OLD.last_safe_error
          AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms)
        OR (NEW.queue_state = 'resuming' AND OLD.retry_due_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND OLD.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.retry_due_at IS NULL AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.claim_generation = OLD.claim_generation + 1 AND NEW.lease_owner IS NOT NULL
          AND NEW.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.automatic_repeats_used = OLD.automatic_repeats_used AND NEW.repeat_budget_remaining = OLD.repeat_budget_remaining
          AND NEW.error_class = OLD.error_class AND NEW.error_code = OLD.error_code AND NEW.last_safe_error = OLD.last_safe_error
          AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms)
        OR (NEW.queue_state = 'timed_out' AND OLD.processing_deadline_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.retry_due_at IS NULL AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.automatic_repeats_used = OLD.automatic_repeats_used AND NEW.repeat_budget_remaining = OLD.repeat_budget_remaining
          AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms
          AND NEW.error_class = 'deadline' AND NEW.error_code = 'processing_deadline_expired'
          AND NEW.last_safe_error = 'The automatic processing deadline expired.')))
    OR (OLD.legacy_retry_wait_v4 = 1 AND NEW.legacy_retry_wait_v4 = 0
      AND NEW.automatic_repeats_used = OLD.automatic_repeats_used AND NEW.repeat_budget_remaining = OLD.repeat_budget_remaining
      AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms
      AND NEW.error_class IS OLD.error_class AND NEW.error_code IS OLD.error_code AND NEW.last_safe_error IS OLD.last_safe_error
      AND (
        (NEW.queue_state = 'resuming' AND OLD.retry_due_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND OLD.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.retry_due_at IS NULL AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.claim_generation = OLD.claim_generation + 1 AND NEW.lease_owner IS NOT NULL
          AND NEW.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER))
        OR (NEW.queue_state = 'timed_out' AND OLD.processing_deadline_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NEW.retry_due_at IS NULL AND NEW.updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER))
      ))
  ) THEN RAISE(ABORT, 'retry wait projection mutation is unauthorized') END;
END;
CREATE TRIGGER career_commands_suspended_budget_immutable
BEFORE UPDATE ON career_commands
WHEN OLD.queue_state = 'suspended' AND NEW.queue_state = 'suspended' AND COALESCE(NOT (
  NEW.processing_started_at = OLD.processing_started_at
  AND NEW.processing_budget_remaining_ms = OLD.processing_budget_remaining_ms
  AND NEW.processing_deadline_at IS NULL AND NEW.suspension_started_at = OLD.suspension_started_at
), 1)
BEGIN SELECT RAISE(ABORT, 'suspended processing budget is immutable'); END;
`;

const normalizedIntakeSql = `
ALTER TABLE career_inbound_events ADD COLUMN intent_kind TEXT CHECK (intent_kind IS NULL OR intent_kind IN ('rejected', 'save_job', 'parked_job'));
ALTER TABLE career_inbound_events ADD COLUMN canonical_url TEXT;
ALTER TABLE career_inbound_events ADD COLUMN thread_id TEXT;
ALTER TABLE career_inbound_events ADD COLUMN origin_destination TEXT;
ALTER TABLE career_inbound_events ADD COLUMN principal_key TEXT;
ALTER TABLE career_inbound_events ADD COLUMN authorization_revision INTEGER CHECK (authorization_revision IS NULL OR authorization_revision >= 0);
ALTER TABLE career_inbound_events ADD COLUMN command_id TEXT REFERENCES career_commands(command_id) ON DELETE RESTRICT;
ALTER TABLE career_inbound_events ADD COLUMN enqueue_position INTEGER CHECK (enqueue_position IS NULL OR enqueue_position > 0);
ALTER TABLE career_commands ADD COLUMN authorization_revision INTEGER CHECK (authorization_revision IS NULL OR authorization_revision >= 0);
CREATE INDEX career_inbound_command_idx ON career_inbound_events(command_id) WHERE command_id IS NOT NULL;
CREATE TRIGGER career_inbound_normalized_insert_valid
BEFORE INSERT ON career_inbound_events
WHEN NEW.intent_kind IS NOT NULL AND COALESCE(NOT (
  length(NEW.owner_resource_id) BETWEEN 1 AND 200
  AND length(NEW.thread_id) BETWEEN 1 AND 256
  AND length(NEW.origin_destination) BETWEEN 1 AND 256
  AND length(NEW.principal_key) BETWEEN 1 AND 256
  AND NEW.authorization_revision IS NOT NULL AND NEW.authorization_revision >= 0
  AND NEW.channel IN ('telegram', 'studio', 'stdio', 'api')
  AND NEW.event_id = NEW.channel || ':' || NEW.transport_event_id
  AND NEW.normalized_hash GLOB 'sha256:[0-9a-f]*'
  AND (
    (NEW.intent_kind = 'rejected' AND NEW.result = 'rejected'
      AND NEW.rejection_reason IN ('unauthorized', 'unsupported_job_url', 'invalid_command', 'edited_message', 'replayed_update',
        'forwarded_message', 'bot_sender', 'non_private_chat', 'missing_sender', 'unauthorized_request')
      AND NEW.canonical_url IS NULL AND NEW.command_id IS NULL AND NEW.enqueue_position IS NULL
      AND NEW.thread_id = 'intake:rejected' AND NEW.origin_destination = 'intake:rejected' AND NEW.principal_key = 'intake:rejected')
    OR
    (NEW.intent_kind = 'parked_job' AND NEW.result = 'accepted' AND NEW.rejection_reason IS NULL
      AND NEW.canonical_url IS NULL AND NEW.command_id IS NULL AND NEW.enqueue_position IS NULL)
    OR
    (NEW.intent_kind = 'save_job' AND NEW.canonical_url IS NOT NULL AND (
      (NEW.result = 'rejected' AND NEW.rejection_reason = 'intake_pending' AND NEW.command_id IS NULL AND NEW.enqueue_position IS NULL)
      OR (NEW.result = 'accepted' AND NEW.rejection_reason IS NULL AND NEW.command_id IS NOT NULL AND NEW.enqueue_position IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM career_commands AS command
          WHERE command.command_id = NEW.command_id
            AND command.owner_resource_id = NEW.owner_resource_id
            AND command.thread_id = NEW.thread_id
            AND command.origin_channel = NEW.channel
            AND command.origin_destination = NEW.origin_destination
            AND command.canonical_url = NEW.canonical_url
            AND command.canonical_job_key = 'url:' || NEW.canonical_url
            AND command.request_id = NEW.channel || ':' || NEW.transport_event_id
            AND command.authorization_revision = NEW.authorization_revision
            AND NEW.enqueue_position = (SELECT count(*) FROM career_commands AS queued
              WHERE queued.queue_state = 'queued' AND queued.queue_sequence <= command.queue_sequence)
        ))
    ))
  )
), 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid normalized inbound event');
END;
CREATE TRIGGER career_inbound_normalized_identity_immutable
BEFORE UPDATE ON career_inbound_events
WHEN COALESCE(NOT (
  OLD.intent_kind = 'save_job' AND OLD.result = 'rejected' AND OLD.rejection_reason = 'intake_pending'
  AND OLD.command_id IS NULL AND OLD.enqueue_position IS NULL
  AND NEW.event_id = OLD.event_id AND NEW.schema_version = OLD.schema_version
  AND NEW.channel = OLD.channel AND NEW.transport_event_id = OLD.transport_event_id
  AND NEW.normalized_hash = OLD.normalized_hash AND NEW.owner_resource_id = OLD.owner_resource_id
  AND NEW.intent_kind = OLD.intent_kind AND NEW.canonical_url = OLD.canonical_url
  AND NEW.thread_id = OLD.thread_id AND NEW.origin_destination = OLD.origin_destination
  AND NEW.principal_key = OLD.principal_key AND NEW.authorization_revision = OLD.authorization_revision
  AND NEW.result = 'accepted' AND NEW.rejection_reason IS NULL
  AND NEW.command_id IS NOT NULL AND NEW.enqueue_position IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM career_commands AS command
    WHERE command.command_id = NEW.command_id
      AND command.owner_resource_id = NEW.owner_resource_id
      AND command.thread_id = NEW.thread_id
      AND command.origin_channel = NEW.channel
      AND command.origin_destination = NEW.origin_destination
      AND command.canonical_url = NEW.canonical_url
      AND command.canonical_job_key = 'url:' || NEW.canonical_url
      AND command.request_id = NEW.channel || ':' || NEW.transport_event_id
      AND command.authorization_revision = NEW.authorization_revision
      AND NEW.enqueue_position = (SELECT count(*) FROM career_commands AS queued
        WHERE queued.queue_state = 'queued' AND queued.queue_sequence <= command.queue_sequence)
  )
  AND NEW.created_at = OLD.created_at
), 1)
BEGIN
  SELECT RAISE(ABORT, 'normalized inbound event is immutable');
END;
CREATE TRIGGER career_commands_authorization_revision_immutable
BEFORE UPDATE OF authorization_revision ON career_commands
WHEN NOT (NEW.authorization_revision IS OLD.authorization_revision)
BEGIN
  SELECT RAISE(ABORT, 'command authorization revision is immutable');
END;
`;

const firstStartDispatchJournalSql = `
CREATE TABLE career_start_dispatch_journal (
  command_id TEXT PRIMARY KEY REFERENCES career_commands(command_id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  workflow_attempt INTEGER NOT NULL CHECK (workflow_attempt > 0),
  run_id TEXT NOT NULL UNIQUE CHECK (run_id = 'cc-save-v1:' || command_id || ':' || workflow_attempt),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
  claim_generation INTEGER NOT NULL CHECK (claim_generation > 0),
  run_creation_state TEXT NOT NULL DEFAULT 'not_created' CHECK (run_creation_state IN ('not_created', 'creating', 'created', 'create_unknown')),
  creation_claim_generation INTEGER CHECK (creation_claim_generation IS NULL OR creation_claim_generation > 0),
  dispatch_state TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (dispatch_state IN ('not_dispatched', 'dispatching', 'dispatched', 'start_unknown')),
  observed_run_status TEXT CHECK (observed_run_status IS NULL OR observed_run_status IN ('pending', 'running', 'waiting', 'suspended', 'success', 'failed', 'tripwire', 'canceled', 'bailed', 'paused', 'skipped')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((run_creation_state = 'not_created' AND creation_claim_generation IS NULL) OR (run_creation_state <> 'not_created' AND creation_claim_generation IS NOT NULL)),
  FOREIGN KEY (command_id, run_id) REFERENCES career_commands(command_id, run_id) ON DELETE RESTRICT
) STRICT;
UPDATE career_commands SET start_dispatch_state = 'start_unknown'
WHERE queue_state = 'starting' AND start_dispatch_state <> 'not_dispatched';
INSERT INTO career_start_dispatch_journal (
  command_id, workflow_version, workflow_attempt, run_id, resource_id, claim_generation,
  run_creation_state, creation_claim_generation, dispatch_state, created_at, updated_at
)
SELECT command_id, workflow_version, workflow_attempt, run_id, owner_resource_id, max(1, claim_generation),
  CASE start_dispatch_state WHEN 'not_dispatched' THEN 'not_created' ELSE 'create_unknown' END,
  CASE start_dispatch_state WHEN 'not_dispatched' THEN NULL ELSE max(1, claim_generation) END,
  start_dispatch_state, processing_started_at, updated_at
FROM career_commands WHERE queue_state = 'starting';
CREATE TRIGGER career_start_dispatch_insert_authority
BEFORE INSERT ON career_start_dispatch_journal
WHEN COALESCE(NOT EXISTS (
  SELECT 1 FROM career_commands c WHERE c.command_id = NEW.command_id AND c.run_id = NEW.run_id
    AND c.workflow_version = NEW.workflow_version AND c.workflow_attempt = NEW.workflow_attempt
    AND c.owner_resource_id = NEW.resource_id AND c.claim_generation = NEW.claim_generation
    AND c.queue_state = 'starting' AND c.lease_owner IS NOT NULL
    AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.start_dispatch_state = NEW.dispatch_state
), 1)
BEGIN SELECT RAISE(ABORT, 'first-start insert authority denied'); END;
CREATE TRIGGER career_start_dispatch_identity_immutable
BEFORE UPDATE OF command_id, schema_version, workflow_version, workflow_attempt, run_id, resource_id, created_at ON career_start_dispatch_journal
BEGIN SELECT RAISE(ABORT, 'first-start correlation is immutable'); END;
CREATE TRIGGER career_start_dispatch_delete_immutable
BEFORE DELETE ON career_start_dispatch_journal
BEGIN SELECT RAISE(ABORT, 'first-start journal is immutable'); END;
CREATE TRIGGER career_start_dispatch_update_authority
BEFORE UPDATE ON career_start_dispatch_journal
WHEN COALESCE(NEW.updated_at < OLD.updated_at OR NOT EXISTS (
  SELECT 1 FROM career_commands c WHERE c.command_id = NEW.command_id AND c.run_id = NEW.run_id
    AND c.workflow_version = NEW.workflow_version AND c.workflow_attempt = NEW.workflow_attempt
    AND c.owner_resource_id = NEW.resource_id AND c.claim_generation = NEW.claim_generation
    AND c.queue_state = 'starting' AND c.lease_owner IS NOT NULL
    AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND c.start_dispatch_state = OLD.dispatch_state
) OR NEW.claim_generation < OLD.claim_generation OR (
  NEW.claim_generation > OLD.claim_generation AND NOT (
    NEW.run_creation_state = OLD.run_creation_state
    AND NEW.creation_claim_generation IS OLD.creation_claim_generation
    AND NEW.dispatch_state = OLD.dispatch_state
    AND NEW.observed_run_status IS OLD.observed_run_status
  )
), 1)
BEGIN SELECT RAISE(ABORT, 'first-start update authority denied'); END;
CREATE TRIGGER career_start_creation_state_transition
BEFORE UPDATE OF run_creation_state, creation_claim_generation ON career_start_dispatch_journal
WHEN NOT (OLD.run_creation_state IS NEW.run_creation_state AND OLD.creation_claim_generation IS NEW.creation_claim_generation) AND NOT (
  (OLD.run_creation_state = 'not_created' AND NEW.run_creation_state = 'creating' AND NEW.creation_claim_generation = NEW.claim_generation) OR
  (OLD.run_creation_state = 'not_created' AND NEW.run_creation_state = 'created' AND NEW.creation_claim_generation = NEW.claim_generation) OR
  (OLD.run_creation_state = 'creating' AND NEW.run_creation_state = 'created' AND NEW.creation_claim_generation = OLD.creation_claim_generation) OR
  (OLD.run_creation_state IN ('creating', 'created') AND NEW.run_creation_state = 'create_unknown' AND NEW.creation_claim_generation = OLD.creation_claim_generation)
)
BEGIN SELECT RAISE(ABORT, 'illegal first-start creation transition'); END;
CREATE TRIGGER career_start_dispatch_state_transition
BEFORE UPDATE OF dispatch_state ON career_start_dispatch_journal
WHEN OLD.dispatch_state <> NEW.dispatch_state AND NOT (
  (OLD.dispatch_state = 'not_dispatched' AND NEW.dispatch_state = 'dispatching' AND NEW.run_creation_state = 'created') OR
  (OLD.dispatch_state = 'not_dispatched' AND NEW.dispatch_state = 'start_unknown') OR
  (OLD.dispatch_state = 'dispatching' AND NEW.dispatch_state IN ('dispatched', 'start_unknown')) OR
  (OLD.dispatch_state = 'dispatched' AND NEW.dispatch_state = 'start_unknown') OR
  (OLD.dispatch_state = 'start_unknown' AND NEW.dispatch_state = 'dispatched' AND NEW.observed_run_status IN ('running','waiting','suspended','success','failed','tripwire','canceled','bailed','paused','skipped'))
)
BEGIN SELECT RAISE(ABORT, 'illegal first-start dispatch transition'); END;
CREATE TRIGGER career_start_observed_terminal_immutable
BEFORE UPDATE OF observed_run_status ON career_start_dispatch_journal
WHEN OLD.observed_run_status IN ('success','failed','tripwire','canceled','bailed','skipped')
  AND NOT (NEW.observed_run_status IS OLD.observed_run_status)
BEGIN SELECT RAISE(ABORT, 'terminal first-start observation is immutable'); END;
CREATE TRIGGER career_commands_start_dispatch_authority
BEFORE UPDATE OF start_dispatch_state ON career_commands
WHEN OLD.start_dispatch_state <> NEW.start_dispatch_state AND COALESCE(
  NOT EXISTS (
    SELECT 1 FROM career_start_dispatch_journal j WHERE j.command_id = NEW.command_id
      AND j.run_id = NEW.run_id AND j.resource_id = NEW.owner_resource_id
      AND j.claim_generation = NEW.claim_generation AND j.dispatch_state = NEW.start_dispatch_state
  ), 1)
BEGIN SELECT RAISE(ABORT, 'command first-start dispatch authority denied'); END;
CREATE TRIGGER career_start_dispatch_project_command
AFTER UPDATE OF dispatch_state ON career_start_dispatch_journal
WHEN OLD.dispatch_state <> NEW.dispatch_state
BEGIN
  UPDATE career_commands SET start_dispatch_state = NEW.dispatch_state, updated_at = NEW.updated_at
  WHERE command_id = NEW.command_id AND run_id = NEW.run_id AND owner_resource_id = NEW.resource_id
    AND claim_generation = NEW.claim_generation AND queue_state = 'starting';
END;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: 'legacy_idempotency_compatibility', sql: legacyCompatibilitySql, checksum: '606b96f6bea28639b2f8699634873cfeb02a1f6ef549bc0b676e2f6c7a8cbd28' }),
  Object.freeze({ version: 2, name: 'durable_v0_records', sql: durableRecordsSql, checksum: '0ba6f834821ae214eb0c168c89417f4a66faf03d0c205cb79ab87ff7182b8617' }),
  Object.freeze({ version: 3, name: 'queue_fencing', sql: queueFencingSql, checksum: 'befa6ba8eec3fcca3fe235e29c6f162ad83482b6f268d073a45534b43ba73d09' }),
  Object.freeze({ version: 4, name: 'normalized_authorized_intake', sql: normalizedIntakeSql, checksum: 'f4a09f69f4cd9c6c777d5d2a1264a70ca6ad55d1df5a4cd155722681e3b7851b' }),
  Object.freeze({ version: 5, name: 'durable_retry_policy', sql: retryPolicySql, checksum: '025bad062c801c0d130eeeb481355ce662e8a6917d38961856d27689a21ccb38' }),
  Object.freeze({ version: 6, name: 'first_start_dispatch_journal', sql: firstStartDispatchJournalSql, checksum: '1987c52f737eae28f1c87f0e74df062f94a6fb08b961df3d24e404153df2389e' }),
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
    if (version >= 3) {
      expected.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
      expected.exec(queueFencingSql);
    }
    if (version >= 4) expected.exec(normalizedIntakeSql);
    if (version >= 5) expected.exec(retryPolicySql);
    if (version >= 6) expected.exec(firstStartDispatchJournalSql);
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

export type EnqueueCommandInput = {
  commandId: string;
  attemptId: string;
  requestId: string;
  canonicalJobKey: string;
  canonicalUrl: string;
  ownerResourceId: string;
  threadId: string;
  originChannel: string;
  originDestination: string;
  authorizationRevision?: number;
};

type AtomicIntakeCommon = {
  channel: 'telegram' | 'studio' | 'stdio' | 'api';
  transportEventId: string;
  payloadHash: string;
  ownerResourceId: string;
  threadId: string;
  originDestination: string;
  principalKey: string;
  authorizationRevision: number;
};
export type IntakeRejectionReason = 'unauthorized' | 'unsupported_job_url' | 'invalid_command'
  | 'edited_message' | 'replayed_update' | 'forwarded_message' | 'bot_sender' | 'non_private_chat' | 'missing_sender' | 'unauthorized_request';
export type AtomicIntakeInput = AtomicIntakeCommon & (
  | { intentKind: 'rejected'; rejectionReason: IntakeRejectionReason }
  | { intentKind: 'parked_job'; requestId: string }
  | { intentKind: 'save_job'; canonicalUrl: string; canonicalJobKey: string; commandId: string; attemptId: string; requestId: string }
);
export type StoredIssuanceAuthorization = {
  channel: AtomicIntakeCommon['channel'];
  ownerResourceId: string;
  threadId: string;
  destination: string;
  principalKey: string;
  authorizationRevision: number;
};
type AcceptedAtomicIntakeResult = { duplicate: boolean; issuanceAuthorization: StoredIssuanceAuthorization };
export type AtomicIntakeResult =
  | { intentKind: 'rejected'; duplicate: boolean; rejectionReason: IntakeRejectionReason }
  | ({ intentKind: 'parked_job' } & AcceptedAtomicIntakeResult)
  | ({ intentKind: 'save_job'; commandId: string; queueSequence: number; queuePosition: number; state: 'queued' } & AcceptedAtomicIntakeResult);

function storedIssuanceAuthorization(row: {
  channel: unknown; ownerResourceId: unknown; threadId: unknown; originDestination: unknown;
  principalKey: unknown; authorizationRevision: unknown;
}): StoredIssuanceAuthorization {
  if (!['telegram', 'studio', 'stdio', 'api'].includes(row.channel as string)
    || typeof row.ownerResourceId !== 'string' || !row.ownerResourceId
    || typeof row.threadId !== 'string' || !row.threadId
    || typeof row.originDestination !== 'string' || !row.originDestination
    || typeof row.principalKey !== 'string' || !row.principalKey
    || !Number.isSafeInteger(row.authorizationRevision) || (row.authorizationRevision as number) < 0) {
    throw new Error('Stored accepted inbound event has incomplete issuance authorization.');
  }
  return {
    channel: row.channel as StoredIssuanceAuthorization['channel'], ownerResourceId: row.ownerResourceId,
    threadId: row.threadId, destination: row.originDestination, principalKey: row.principalKey,
    authorizationRevision: row.authorizationRevision as number,
  };
}

const atomicIntakeFields = new Set([
  'channel', 'transportEventId', 'payloadHash', 'ownerResourceId', 'threadId', 'originDestination',
  'principalKey', 'authorizationRevision', 'intentKind', 'rejectionReason', 'canonicalUrl', 'canonicalJobKey', 'commandId', 'attemptId', 'requestId',
]);

function assertAtomicIntakeInput(input: AtomicIntakeInput): void {
  if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !atomicIntakeFields.has(key))) {
    throw new Error('Inbound intake shape is invalid.');
  }
  if (!['telegram', 'studio', 'stdio', 'api'].includes(input.channel)) throw new Error('Inbound channel is invalid.');
  if (!['rejected', 'save_job', 'parked_job'].includes(input.intentKind)) throw new Error('Inbound intent is invalid.');
  const safeCorrelation = /^[A-Za-z0-9_.:@-]{1,256}$/;
  for (const [name, value] of [
    ['transport event ID', input.transportEventId], ['owner resource ID', input.ownerResourceId],
    ['thread ID', input.threadId], ['origin destination', input.originDestination], ['principal key', input.principalKey],
  ] as const) if (typeof value !== 'string' || !safeCorrelation.test(value)) throw new Error(`Inbound ${name} is invalid.`);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.payloadHash)) throw new Error('Inbound payload hash must be a safe SHA-256 value.');
  if (!Number.isSafeInteger(input.authorizationRevision) || input.authorizationRevision < 0) throw new Error('Inbound authorization revision is invalid.');

  const saveFieldNames = ['canonicalUrl', 'canonicalJobKey', 'commandId', 'attemptId'] as const;
  const saveFields = saveFieldNames.map((name) => input.intentKind === 'save_job' ? input[name] : undefined);
  if (input.intentKind === 'rejected') {
    const reasons: readonly string[] = ['unauthorized', 'unsupported_job_url', 'invalid_command', 'edited_message', 'replayed_update',
      'forwarded_message', 'bot_sender', 'non_private_chat', 'missing_sender', 'unauthorized_request'];
    if (!reasons.includes(input.rejectionReason) || input.threadId !== 'intake:rejected'
      || input.originDestination !== 'intake:rejected' || input.principalKey !== 'intake:rejected'
      || ['requestId', ...saveFieldNames].some((name) => Object.hasOwn(input, name))) throw new Error('Rejected intake correlation is invalid.');
    return;
  }
  if (Object.hasOwn(input, 'rejectionReason')) throw new Error('Accepted intake forbids rejection correlation.');
  if (typeof input.requestId !== 'string' || !safeCorrelation.test(input.requestId)
    || input.requestId !== `${input.channel}:${input.transportEventId}`) throw new Error('Inbound request ID is invalid.');
  if (input.intentKind === 'parked_job') {
    if (saveFieldNames.some((name) => Object.hasOwn(input, name))) throw new Error('Parked intake forbids save command correlation.');
    return;
  }
  if (saveFieldNames.some((name) => !Object.hasOwn(input, name)) || saveFields.some((value) => typeof value !== 'string')) {
    throw new Error('Save intake requires complete command correlation.');
  }
  if (!safeCorrelation.test(input.commandId!) || !safeCorrelation.test(input.attemptId!)) throw new Error('Save command correlation is invalid.');
  const value = input.canonicalUrl!;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Save intake canonical URL is invalid.'); }
  if (value.length > 2048 || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port
    || url.hash || url.href !== value || input.canonicalJobKey !== buildJobIdempotencyKey({ url: value })) {
    throw new Error('Save intake canonical URL or job key is invalid.');
  }
}

export type QueueClaim = {
  commandId: string;
  runId: string;
  ownerResourceId: string;
  queueState: 'starting' | 'running' | 'resuming';
  leaseOwner: string;
  claimGeneration: number;
  leaseExpiresAt: number;
  heartbeatAt: number;
};

export type WorkerFence = {
  commandId: string;
  runId: string;
  ownerResourceId: string;
  leaseOwner: string;
  claimGeneration: number;
  sourceState: 'starting' | 'running' | 'resuming';
};

export type WorkerWriteResult = { applied: true; updatedAt: number } | { applied: false; reason: 'lease_lost' };
export type FirstStartJournal = {
  commandId: string;
  workflowVersion: number;
  workflowAttempt: number;
  runId: string;
  resourceId: string;
  claimGeneration: number;
  runCreationState: 'not_created' | 'creating' | 'created' | 'create_unknown';
  creationClaimGeneration: number | null;
  dispatchState: 'not_dispatched' | 'dispatching' | 'dispatched' | 'start_unknown';
  observedRunStatus: 'pending' | 'running' | 'waiting' | 'suspended' | 'success' | 'failed' | 'tripwire' | 'canceled' | 'bailed' | 'paused' | 'skipped' | null;
  canonicalUrl: string;
};
export type RetryScheduleInput = {
  scheduleKey: string;
  stage: RetryStage;
  failure: { class: FailureClass; code: SafeFailureCode };
  policy: RetryPolicyResult;
};
export type RetryScheduleResult =
  | { applied: true; duplicate: boolean; automaticRepeatsUsed: number; stageRepeatsUsed: number }
  | { applied: false; reason: 'invalid' | 'lease_lost' | 'deadline_expired' | 'budget_exhausted' | 'stage_cap_exhausted' | 'non_retryable' };

export class CareerStore {
  private readonly database: DatabaseSync;
  private readonly leaseMs: number;
  private readonly processingDeadlineMs: number;
  private migrationsVerified = false;

  constructor(databaseUrl: string, options: { leaseMs?: number; processingDeadlineMs?: number } = {}) {
    const verifiedUrl = assertOperationalDatabaseUrl(databaseUrl);
    this.leaseMs = options.leaseMs ?? 120_000;
    this.processingDeadlineMs = options.processingDeadlineMs ?? 1_800_000;
    if (!Number.isSafeInteger(this.processingDeadlineMs) || this.processingDeadlineMs <= 0 || this.processingDeadlineMs > 1_800_000) {
      throw new Error('Processing deadline must be a positive integer no greater than 30 minutes.');
    }
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
      const appliedCount = ledgerExists(this.database)
        ? Number((this.database.prepare('SELECT count(*) AS count FROM schema_migrations').get() as { count: number }).count)
        : 0;
      const rebuildingCommands = appliedCount === 2;
      if (rebuildingCommands) this.database.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
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
          this.database.exec('COMMIT');
          this.migrationsVerified = true;
          continue;
        }
        if (applied.length === 0) throw new Error('Unsupported empty schema migration ledger.');
        verifyInstalledSchema(this.database, applied.length, applied[0].legacy_outbox_preserved === 1);
        const migration = MIGRATIONS[applied.length];
        this.database.exec(migration.sql);
        if ((this.database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length !== 0) throw new Error('Queue migration introduced a foreign key violation.');
        this.database.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at, legacy_outbox_preserved) VALUES (?, ?, ?, ?, 0)').run(migration.version, migration.name, migration.checksum, Date.now());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      } finally {
        if (rebuildingCommands) this.database.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
      }
    }
    if ((this.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1) throw new Error('Installed schema verification failed: foreign keys are disabled.');
  }

  migrationStatus(): { currentVersion: number; verified: boolean } {
    return { currentVersion: MIGRATIONS.length, verified: this.migrationsVerified };
  }

  private databaseNow(): number {
    return Number((this.database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get() as { now: number }).now);
  }

  recordInboundAndEnqueue(input: AtomicIntakeInput): AtomicIntakeResult {
    assertAtomicIntakeInput(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.database.prepare(`
        SELECT normalized_hash AS payloadHash, channel, owner_resource_id AS ownerResourceId, thread_id AS threadId,
          origin_destination AS originDestination, principal_key AS principalKey, authorization_revision AS authorizationRevision,
          intent_kind AS intentKind, canonical_url AS canonicalUrl, command_id AS commandId, enqueue_position AS queuePosition,
          result, rejection_reason AS rejectionReason
        FROM career_inbound_events WHERE channel = ? AND transport_event_id = ?
      `).get(input.channel, input.transportEventId) as {
        payloadHash: string; channel: string; ownerResourceId: string; threadId: string | null; originDestination: string | null; principalKey: string | null;
        authorizationRevision: number | null; intentKind: 'rejected' | 'save_job' | 'parked_job' | null; canonicalUrl: string | null;
        commandId: string | null; queuePosition: number | null; result: 'accepted' | 'rejected'; rejectionReason: IntakeRejectionReason | 'intake_pending' | null;
      } | undefined;
      if (duplicate) {
        const storedHash = Buffer.from(duplicate.payloadHash, 'utf8');
        const candidateHash = Buffer.from(input.payloadHash, 'utf8');
        const hashMatches = storedHash.byteLength === candidateHash.byteLength && timingSafeEqual(storedHash, candidateHash);
        if (!hashMatches) throw new Error('Conflicting transport replay.');
        if (duplicate.intentKind === 'rejected') {
          if (!duplicate.rejectionReason || duplicate.rejectionReason === 'intake_pending') throw new Error('Stored rejected inbound event is invalid.');
          this.database.exec('COMMIT');
          return { intentKind: 'rejected', duplicate: true, rejectionReason: duplicate.rejectionReason };
        }
        const issuanceAuthorization = storedIssuanceAuthorization(duplicate);
        if (duplicate.intentKind === 'parked_job') {
          this.database.exec('COMMIT');
          return { intentKind: 'parked_job', duplicate: true, issuanceAuthorization };
        }
        if (!duplicate.commandId || duplicate.queuePosition === null) throw new Error('Stored inbound event is missing command correlation.');
        const command = this.database.prepare('SELECT queue_sequence AS queueSequence FROM career_commands WHERE command_id = ?').get(duplicate.commandId) as { queueSequence: number } | undefined;
        if (!command) throw new Error('Stored inbound command correlation is unavailable.');
        this.database.exec('COMMIT');
        return { intentKind: 'save_job', duplicate: true, commandId: duplicate.commandId, queueSequence: command.queueSequence, queuePosition: duplicate.queuePosition, state: 'queued', issuanceAuthorization };
      }

      const now = this.databaseNow();
      const eventId = `${input.channel}:${input.transportEventId}`;
      const isRejected = input.intentKind === 'rejected';
      this.database.prepare(`
        INSERT INTO career_inbound_events (
          event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, rejection_reason, created_at,
          intent_kind, canonical_url, thread_id, origin_destination, principal_key, authorization_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, input.channel, input.transportEventId, input.payloadHash, input.ownerResourceId,
        input.intentKind === 'parked_job' ? 'accepted' : 'rejected', isRejected ? input.rejectionReason : input.intentKind === 'save_job' ? 'intake_pending' : null,
        now, input.intentKind, input.intentKind === 'save_job' ? input.canonicalUrl : null,
        input.threadId, input.originDestination, input.principalKey, input.authorizationRevision);

      if (isRejected) {
        this.database.exec('COMMIT');
        return { intentKind: 'rejected', duplicate: false, rejectionReason: input.rejectionReason };
      }
      const issuanceAuthorization = storedIssuanceAuthorization(this.database.prepare(`
        SELECT channel, owner_resource_id AS ownerResourceId, thread_id AS threadId,
          origin_destination AS originDestination, principal_key AS principalKey, authorization_revision AS authorizationRevision
        FROM career_inbound_events WHERE event_id = ?
      `).get(eventId) as Parameters<typeof storedIssuanceAuthorization>[0]);
      if (input.intentKind === 'parked_job') {
        this.database.exec('COMMIT');
        return { intentKind: 'parked_job', duplicate: false, issuanceAuthorization };
      }
      if (!input.canonicalUrl || !input.canonicalJobKey || !input.commandId || !input.attemptId) throw new Error('Save intake requires complete command correlation.');
      this.database.prepare(`
        INSERT INTO career_commands (
          command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id,
          thread_id, origin_channel, origin_destination, authorization_revision, queue_state, created_at, updated_at, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        input.commandId, input.attemptId, input.requestId, input.canonicalJobKey, input.canonicalUrl,
        input.ownerResourceId, input.threadId, input.channel, input.originDestination, input.authorizationRevision, now, now, now,
      );
      const command = this.database.prepare('SELECT queue_sequence AS queueSequence FROM career_commands WHERE command_id = ?').get(input.commandId) as { queueSequence: number };
      const queuePosition = Number((this.database.prepare("SELECT count(*) AS count FROM career_commands WHERE queue_state = 'queued' AND queue_sequence <= ?").get(command.queueSequence) as { count: number }).count);
      this.database.prepare("UPDATE career_inbound_events SET result = 'accepted', rejection_reason = NULL, command_id = ?, enqueue_position = ? WHERE event_id = ? AND result = 'rejected' AND rejection_reason = 'intake_pending' AND command_id IS NULL").run(input.commandId, queuePosition, eventId);
      this.database.exec('COMMIT');
      return { intentKind: 'save_job', duplicate: false, commandId: input.commandId, queueSequence: command.queueSequence, queuePosition, state: 'queued', issuanceAuthorization };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getCommandCount(): number {
    return Number((this.database.prepare('SELECT count(*) AS count FROM career_commands').get() as { count: number }).count);
  }

  enqueueCommand(input: EnqueueCommandInput): { commandId: string; queueSequence: number; position: number; state: 'queued' } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = this.databaseNow();
      this.database.prepare(`
        INSERT INTO career_commands (
          command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id,
          thread_id, origin_channel, origin_destination, authorization_revision, queue_state, created_at, updated_at, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(
        input.commandId, input.attemptId, input.requestId, input.canonicalJobKey, input.canonicalUrl,
        input.ownerResourceId, input.threadId, input.originChannel, input.originDestination, input.authorizationRevision ?? null, now, now, now,
      );
      const row = this.database.prepare('SELECT queue_sequence AS queueSequence FROM career_commands WHERE command_id = ?').get(input.commandId) as { queueSequence: number };
      const position = Number((this.database.prepare("SELECT count(*) AS count FROM career_commands WHERE queue_state = 'queued' AND queue_sequence <= ?").get(row.queueSequence) as { count: number }).count);
      this.database.exec('COMMIT');
      return { commandId: input.commandId, queueSequence: row.queueSequence, position, state: 'queued' };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  queuePosition(commandId: string): number | null {
    const row = this.database.prepare("SELECT queue_sequence AS queueSequence FROM career_commands WHERE command_id = ? AND queue_state = 'queued'").get(commandId) as { queueSequence: number } | undefined;
    if (!row) return null;
    return Number((this.database.prepare("SELECT count(*) AS count FROM career_commands WHERE queue_state = 'queued' AND queue_sequence <= ?").get(row.queueSequence) as { count: number }).count);
  }

  claimNextRunnable(leaseOwner: string): QueueClaim | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = this.databaseNow();
      const current = this.database.prepare(`
        SELECT command_id AS commandId, owner_resource_id AS ownerResourceId, queue_state AS queueState,
          workflow_attempt AS workflowAttempt, run_id AS runId
        FROM career_commands
        WHERE
          queue_state = 'queued'
          OR (queue_state = 'retry_wait' AND retry_due_at <= ? AND processing_deadline_at > ?)
          OR (queue_state IN ('starting', 'running', 'resuming') AND lease_expires_at <= ? AND processing_deadline_at > ?)
        ORDER BY queue_sequence
        LIMIT 1
      `).get(now, now, now, now) as { commandId: string; ownerResourceId: string; queueState: QueueStateV0; workflowAttempt: number; runId: string | null } | undefined;
      if (!current) {
        this.database.exec('COMMIT');
        return null;
      }

      let nextState: 'starting' | 'running' | 'resuming';
      let runId = current.runId;
      let result;
      if (current.queueState === 'queued') {
        nextState = 'starting';
        runId = `cc-save-v1:${current.commandId}:${current.workflowAttempt}`;
        result = this.database.prepare(`
          UPDATE career_commands
          SET queue_state = 'starting', run_id = ?, claim_generation = claim_generation + 1,
              lease_owner = ?, lease_expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?,
              heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
              processing_started_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
              processing_deadline_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?,
              processing_budget_remaining_ms = ?, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE command_id = ? AND owner_resource_id = ? AND queue_state = 'queued'
        `).run(runId, leaseOwner, this.leaseMs, this.processingDeadlineMs, this.processingDeadlineMs, current.commandId, current.ownerResourceId);
      } else if (current.queueState === 'retry_wait') {
        nextState = 'resuming';
        result = this.database.prepare(`
          UPDATE career_commands
          SET queue_state = 'resuming', claim_generation = claim_generation + 1, lease_owner = ?,
              lease_expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?,
              heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), retry_due_at = NULL,
              legacy_retry_wait_v4 = 0, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE command_id = ? AND owner_resource_id = ? AND queue_state = 'retry_wait'
            AND retry_due_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
            AND processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        `).run(leaseOwner, this.leaseMs, current.commandId, current.ownerResourceId);
      } else {
        if (!['starting', 'running', 'resuming'].includes(current.queueState)) throw new Error('Selected queue state is not claimable.');
        nextState = current.queueState as 'starting' | 'running' | 'resuming';
        result = this.database.prepare(`
          UPDATE career_commands
          SET claim_generation = claim_generation + 1, lease_owner = ?,
              lease_expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?,
              heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE command_id = ? AND owner_resource_id = ? AND queue_state = ?
            AND lease_expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
            AND processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        `).run(leaseOwner, this.leaseMs, current.commandId, current.ownerResourceId, current.queueState);
      }
      if (Number(result.changes) !== 1 || runId === null) throw new Error('Atomic queue claim lost unexpectedly.');
      if (nextState === 'starting') {
        this.database.prepare(`
          INSERT INTO career_start_dispatch_journal (
            command_id, workflow_version, workflow_attempt, run_id, resource_id, claim_generation,
            run_creation_state, dispatch_state, created_at, updated_at
          )
          SELECT command_id, workflow_version, workflow_attempt, run_id, owner_resource_id, claim_generation,
            'not_created', start_dispatch_state, processing_started_at, updated_at
          FROM career_commands WHERE command_id = ?
          ON CONFLICT(command_id) DO UPDATE SET claim_generation = excluded.claim_generation, updated_at = excluded.updated_at
        `).run(current.commandId);
      }
      const persisted = this.database.prepare(`SELECT claim_generation AS generation, lease_expires_at AS leaseExpiresAt,
        heartbeat_at AS heartbeatAt FROM career_commands WHERE command_id = ?`).get(current.commandId) as { generation: number; leaseExpiresAt: number; heartbeatAt: number };
      this.database.exec('COMMIT');
      return { commandId: current.commandId, runId, ownerResourceId: current.ownerResourceId, queueState: nextState, leaseOwner,
        claimGeneration: Number(persisted.generation), leaseExpiresAt: persisted.leaseExpiresAt, heartbeatAt: persisted.heartbeatAt };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private workerWrite(sql: string, fence: WorkerFence): WorkerWriteResult {
    const result = this.database.prepare(sql).get(
      fence.commandId, fence.runId, fence.ownerResourceId, fence.leaseOwner, fence.claimGeneration, fence.sourceState,
    ) as { updatedAt: number } | undefined;
    return result ? { applied: true, updatedAt: Number(result.updatedAt) } : { applied: false, reason: 'lease_lost' };
  }

  renewClaim(fence: WorkerFence): WorkerWriteResult {
    const result = this.database.prepare(`
      UPDATE career_commands
      SET lease_expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?,
          heartbeat_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
          updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE command_id = ? AND run_id = ? AND owner_resource_id = ? AND lease_owner = ?
        AND claim_generation = ? AND queue_state = ?
        AND lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      RETURNING updated_at AS updatedAt
    `).get(
      this.leaseMs, fence.commandId, fence.runId, fence.ownerResourceId,
      fence.leaseOwner, fence.claimGeneration, fence.sourceState,
    ) as { updatedAt: number } | undefined;
    return result ? { applied: true, updatedAt: Number(result.updatedAt) } : { applied: false, reason: 'lease_lost' };
  }

  getFirstStartJournal(commandId: string): FirstStartJournal | undefined {
    return this.database.prepare(`
      SELECT j.command_id AS commandId, j.workflow_version AS workflowVersion, j.workflow_attempt AS workflowAttempt,
        j.run_id AS runId, j.resource_id AS resourceId, j.claim_generation AS claimGeneration,
        j.run_creation_state AS runCreationState, j.creation_claim_generation AS creationClaimGeneration, j.dispatch_state AS dispatchState,
        j.observed_run_status AS observedRunStatus, c.canonical_url AS canonicalUrl
      FROM career_start_dispatch_journal j JOIN career_commands c ON c.command_id = j.command_id
      WHERE j.command_id = ?
    `).get(commandId) as FirstStartJournal | undefined;
  }

  private updateFirstStart(fence: WorkerFence, journalSet: string, predicate = '1'): WorkerWriteResult {
    const safeId = /^[A-Za-z0-9_.:@-]{1,200}$/;
    if (!fence || typeof fence !== 'object' || fence.sourceState !== 'starting'
      || ![fence.commandId, fence.runId, fence.ownerResourceId, fence.leaseOwner].every((value) => typeof value === 'string' && safeId.test(value))
      || !Number.isSafeInteger(fence.claimGeneration) || fence.claimGeneration < 1) return { applied: false, reason: 'lease_lost' };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`
          UPDATE career_start_dispatch_journal AS j SET ${journalSet}, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE command_id = ? AND run_id = ? AND resource_id = ? AND claim_generation = ? AND (${predicate})
            AND EXISTS (SELECT 1 FROM career_commands c WHERE c.command_id = j.command_id AND c.run_id = j.run_id
              AND c.owner_resource_id = j.resource_id AND c.lease_owner = ? AND c.claim_generation = ? AND c.queue_state = ?
              AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
              AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))
          RETURNING updated_at AS updatedAt
      `).get(fence.commandId, fence.runId, fence.ownerResourceId, fence.claimGeneration,
        fence.leaseOwner, fence.claimGeneration, fence.sourceState) as { updatedAt: number } | undefined;
      if (!row) {
        this.database.exec('ROLLBACK');
        return { applied: false, reason: 'lease_lost' };
      }
      this.database.exec('COMMIT');
      return { applied: true, updatedAt: Number(row.updatedAt) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  claimFirstRunCreation(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence,
      `run_creation_state = 'creating', creation_claim_generation = ${Number(fence.claimGeneration)}`, "run_creation_state = 'not_created'");
  }

  markFirstRunCreated(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence,
      `run_creation_state = 'created', creation_claim_generation = COALESCE(creation_claim_generation, ${Number(fence.claimGeneration)})`,
      `run_creation_state IN ('not_created', 'creating', 'created')`);
  }

  markFirstRunCreateUnknown(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence,
      `run_creation_state = 'create_unknown', dispatch_state = 'start_unknown'`, "run_creation_state IN ('creating', 'created')");
  }

  markFirstStartDispatching(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence, `dispatch_state = 'dispatching'`, "dispatch_state = 'not_dispatched' AND run_creation_state = 'created'");
  }

  markFirstStartDispatched(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence, `dispatch_state = 'dispatched'`, "dispatch_state = 'dispatching'");
  }

  markFirstStartUnknown(fence: WorkerFence): WorkerWriteResult {
    return this.updateFirstStart(fence, `dispatch_state = 'start_unknown'`, "dispatch_state IN ('dispatching', 'dispatched')");
  }

  recordFirstStartObservation(fence: WorkerFence, status: FirstStartJournal['observedRunStatus']): WorkerWriteResult {
    if (status === null) return { applied: false, reason: 'lease_lost' };
    const allowed: readonly NonNullable<FirstStartJournal['observedRunStatus']>[] = ['pending', 'running', 'waiting', 'suspended', 'success', 'failed', 'tripwire', 'canceled', 'bailed', 'paused', 'skipped'];
    if (!allowed.includes(status)) return { applied: false, reason: 'lease_lost' };
    if (status === 'pending') return this.updateFirstStart(fence, `observed_run_status = '${status}'`);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let updatedAt = this.updateFirstStartInOpenTransaction(fence, `observed_run_status = '${status}'`);
        if (!updatedAt) { this.database.exec('ROLLBACK'); return { applied: false, reason: 'lease_lost' }; }
        const current = this.getFirstStartJournal(fence.commandId);
        if (current?.dispatchState === 'not_dispatched') {
          updatedAt = this.updateFirstStartInOpenTransaction(fence, "dispatch_state = 'dispatching'");
          if (!updatedAt) { this.database.exec('ROLLBACK'); return { applied: false, reason: 'lease_lost' }; }
        }
        const after = this.getFirstStartJournal(fence.commandId);
        if (after && after.dispatchState !== 'dispatched') {
          updatedAt = this.updateFirstStartInOpenTransaction(fence, "dispatch_state = 'dispatched'");
          if (!updatedAt) { this.database.exec('ROLLBACK'); return { applied: false, reason: 'lease_lost' }; }
        }
      this.database.exec('COMMIT');
      return { applied: true, updatedAt };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private updateFirstStartInOpenTransaction(fence: WorkerFence, journalSet: string): number | null {
    const row = this.database.prepare(`UPDATE career_start_dispatch_journal AS j SET ${journalSet}, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE command_id = ? AND run_id = ? AND resource_id = ? AND claim_generation = ?
        AND EXISTS (SELECT 1 FROM career_commands c WHERE c.command_id = j.command_id AND c.run_id = j.run_id
          AND c.owner_resource_id = j.resource_id AND c.lease_owner = ? AND c.claim_generation = ? AND c.queue_state = ?
          AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)) RETURNING updated_at AS updatedAt`)
      .get(fence.commandId, fence.runId, fence.ownerResourceId, fence.claimGeneration, fence.leaseOwner, fence.claimGeneration, fence.sourceState) as { updatedAt: number } | undefined;
    return row ? Number(row.updatedAt) : null;
  }

  markRunning(fence: WorkerFence): WorkerWriteResult {
    if (fence.sourceState !== 'starting' && fence.sourceState !== 'resuming') return { applied: false, reason: 'lease_lost' };
    return this.workerWrite(`
      UPDATE career_commands
      SET queue_state = 'running', blocker_id = NULL, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE command_id = ? AND run_id = ? AND owner_resource_id = ? AND lease_owner = ? AND claim_generation = ? AND queue_state = ?
        AND lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND start_dispatch_state = 'dispatched'
        AND (career_commands.queue_state = 'resuming' OR EXISTS (
          SELECT 1 FROM career_start_dispatch_journal j WHERE j.command_id = career_commands.command_id
            AND j.run_id = career_commands.run_id AND j.resource_id = career_commands.owner_resource_id
            AND j.claim_generation = career_commands.claim_generation AND j.dispatch_state = 'dispatched'
            AND j.observed_run_status = 'running'
        ))
      RETURNING updated_at AS updatedAt
    `, fence);
  }

  scheduleRetry(fence: WorkerFence, input: RetryScheduleInput): RetryScheduleResult {
    const safeId = /^[A-Za-z0-9_.:@-]{1,200}$/;
    if (!fence || typeof fence !== 'object'
      || ![fence.commandId, fence.runId, fence.ownerResourceId, fence.leaseOwner].every((value) => typeof value === 'string' && safeId.test(value))
      || !Number.isSafeInteger(fence.claimGeneration) || fence.claimGeneration < 1 || fence.sourceState !== 'running'
      || !input || typeof input !== 'object'
      || Object.keys(input).some((key) => !['scheduleKey', 'stage', 'failure', 'policy'].includes(key))) {
      return { applied: false, reason: 'invalid' };
    }
    const policy = input.policy;
    let failure;
    try {
      failure = classifyFailure({ kind: input?.failure?.class, stage: input?.stage, code: input?.failure?.code,
        ...(policy?.source === 'retry_after' ? { retryAfter: policy.retryAfter } : {}) });
    } catch {
      return { applied: false, reason: 'invalid' };
    }
    const ceiling = Number.isSafeInteger(policy?.attempt) && policy.attempt > 0
      ? Math.min(60_000, 2_000 * (2 ** (policy.attempt - 1))) : -1;
    let retryAfterValid = true;
    if (policy?.source === 'retry_after') {
      try {
        const recomputed = computeRetrySchedule({ failure, attempt: policy.attempt, processingDeadlineAt: Number.MAX_SAFE_INTEGER,
          clock: () => policy.calculatedAt, rng: () => 0 });
        retryAfterValid = recomputed.retry && recomputed.delayMs === policy.delayMs && recomputed.source === policy.source;
      } catch { retryAfterValid = false; }
    }
    if (!input.failure || typeof input.failure !== 'object' || Object.keys(input.failure).some((key) => !['class', 'code'].includes(key))
      || !policy || typeof policy !== 'object' || Object.keys(policy).some((key) => !['retry', 'delayMs', 'attempt', 'calculatedAt', 'policyTargetAt', 'source', 'retryAfter'].includes(key))
      || policy.retry !== true || !safeId.test(input.scheduleKey)
      || !Number.isSafeInteger(policy.delayMs) || policy.delayMs < 0
      || !Number.isSafeInteger(policy.calculatedAt) || policy.calculatedAt < 0
      || !Number.isSafeInteger(policy.policyTargetAt) || policy.policyTargetAt !== policy.calculatedAt + policy.delayMs
      || !Number.isSafeInteger(policy.attempt) || policy.attempt < 1
      || (policy.source === 'jitter' && (failure.class !== 'transient' || policy.delayMs > ceiling || Object.hasOwn(policy, 'retryAfter')))
      || (policy.source === 'retry_after' && (failure.class !== 'rate_limited' || !retryAfterValid))
      || !['transient', 'rate_limited'].includes(failure.class)) {
      return { applied: false, reason: failure.class === 'transient' || failure.class === 'rate_limited' ? 'invalid' : 'non_retryable' };
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare(`
        SELECT r.command_id AS commandId, r.run_id AS runId, r.owner_resource_id AS ownerResourceId,
          r.stage_key AS stage, r.failure_class AS failureClass, r.failure_code AS failureCode, r.safe_detail AS safeDetail,
          r.stage_repeat AS stageRepeatsUsed, r.automatic_repeat_ordinal AS automaticRepeatsUsed,
          r.policy_attempt AS policyAttempt, r.policy_source AS policySource, r.policy_calculated_at AS calculatedAt,
          r.policy_delay_ms AS delayMs, r.policy_target_at AS policyTargetAt, r.retry_after_value AS retryAfter,
          r.lease_owner AS leaseOwner, r.claim_generation AS claimGeneration
        FROM career_retry_schedules r WHERE r.command_id = ? AND r.schedule_key = ?
      `).get(fence.commandId, input.scheduleKey) as Record<string, string | number | null> | undefined;
      if (existing) {
        if (existing.runId !== fence.runId || existing.ownerResourceId !== fence.ownerResourceId
          || existing.leaseOwner !== fence.leaseOwner || existing.claimGeneration !== fence.claimGeneration) {
          this.database.exec('COMMIT');
          return { applied: false, reason: 'lease_lost' };
        }
        const same = existing.commandId === fence.commandId && existing.stage === input.stage
          && existing.failureClass === failure.class && existing.failureCode === failure.code && existing.safeDetail === failure.safeDetail
          && existing.policyAttempt === policy.attempt && existing.policySource === policy.source
          && existing.calculatedAt === policy.calculatedAt && existing.delayMs === policy.delayMs
          && existing.policyTargetAt === policy.policyTargetAt
          && existing.retryAfter === (policy.source === 'retry_after' ? policy.retryAfter : null);
        this.database.exec('COMMIT');
        return same
          ? { applied: true, duplicate: true, automaticRepeatsUsed: Number(existing.automaticRepeatsUsed), stageRepeatsUsed: Number(existing.stageRepeatsUsed) }
          : { applied: false, reason: 'invalid' };
      }
      const now = this.databaseNow();
      if (policy.calculatedAt > now) { this.database.exec('COMMIT'); return { applied: false, reason: 'invalid' }; }
      const command = this.database.prepare(`
        SELECT automatic_repeats_used AS used, processing_deadline_at AS deadline
        FROM career_commands WHERE command_id = ? AND run_id = ? AND owner_resource_id = ?
          AND lease_owner = ? AND claim_generation = ? AND queue_state = 'running' AND lease_expires_at > ?
      `).get(fence.commandId, fence.runId, fence.ownerResourceId, fence.leaseOwner, fence.claimGeneration, now) as { used: number; deadline: number } | undefined;
      if (!command) { this.database.exec('COMMIT'); return { applied: false, reason: 'lease_lost' }; }
      const dueAt = Math.max(now, policy.policyTargetAt);
      if (!Number.isSafeInteger(dueAt) || command.deadline <= now || dueAt >= command.deadline) { this.database.exec('COMMIT'); return { applied: false, reason: 'deadline_expired' }; }
      if (command.used >= 5) { this.database.exec('COMMIT'); return { applied: false, reason: 'budget_exhausted' }; }
      const stageUsed = Number((this.database.prepare('SELECT count(*) AS count FROM career_retry_schedules WHERE command_id = ? AND stage_key = ?').get(fence.commandId, input.stage) as { count: number }).count);
      if (stageUsed >= STAGE_REPEAT_CAPS[input.stage]) { this.database.exec('COMMIT'); return { applied: false, reason: 'stage_cap_exhausted' }; }
      if (policy.attempt !== stageUsed + 1) { this.database.exec('COMMIT'); return { applied: false, reason: 'invalid' }; }
      this.database.prepare(`
        INSERT INTO career_retry_schedules (
          command_id, schedule_key, run_id, owner_resource_id, lease_owner, claim_generation,
          stage_key, stage_repeat, automatic_repeat_ordinal, policy_attempt, policy_source, policy_calculated_at,
          policy_delay_ms, policy_target_at, retry_after_value, failure_class, failure_code, safe_detail, scheduled_at, due_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fence.commandId, input.scheduleKey, fence.runId, fence.ownerResourceId, fence.leaseOwner, fence.claimGeneration,
        input.stage, stageUsed + 1, command.used + 1, policy.attempt, policy.source, policy.calculatedAt,
        policy.delayMs, policy.policyTargetAt, policy.source === 'retry_after' ? policy.retryAfter : null,
        failure.class, failure.code, failure.safeDetail, now, dueAt);
      this.database.exec('COMMIT');
      return { applied: true, duplicate: false, automaticRepeatsUsed: command.used + 1, stageRepeatsUsed: stageUsed + 1 };
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (/invalid retry schedule authority|processing time mutation is unauthorized|retry wait projection mutation is unauthorized|CHECK constraint|UNIQUE constraint/i.test(String((error as Error)?.message))) {
        return { applied: false, reason: 'invalid' };
      }
      throw error;
    }
  }

  createLinkedTerminalRetry(input: {
    parentCommandId: string; commandId: string; attemptId: string; requestId: string;
    freshAuthorization: OwnerAuthorizationCapability;
  }): { commandId: string; queueSequence: number; state: 'queued' } {
    const authorization = input?.freshAuthorization;
    const safeId = /^[A-Za-z0-9_.:@-]{1,200}$/;
    if (!isOwnerAuthorizationCapability(authorization)
      || Object.keys(authorization).some((key) => !['resourceId', 'threadId', 'destination', 'channel', 'principalKey', 'authorizationRevision'].includes(key))
      || !['telegram', 'studio', 'stdio', 'api'].includes(authorization.channel)
      || !Number.isSafeInteger(authorization.authorizationRevision) || authorization.authorizationRevision < 0
      || ![input.parentCommandId, input.commandId, input.attemptId, input.requestId, authorization.resourceId,
        authorization.threadId, authorization.destination, authorization.principalKey].every((value) => typeof value === 'string' && safeId.test(value))) {
      throw new Error('Terminal retry requires complete fresh server authorization correlation.');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const parent = this.database.prepare(`
        WITH RECURSIVE lineage(command_id) AS (
          SELECT ?
          UNION
          SELECT c.parent_command_id FROM career_commands c JOIN lineage l ON c.command_id = l.command_id
          WHERE c.parent_command_id IS NOT NULL
          LIMIT 101
        ), provenance AS (
          SELECT i.principal_key AS principal_key
          FROM lineage l
          JOIN career_commands root ON root.command_id = l.command_id AND root.parent_command_id IS NULL
          JOIN career_inbound_events i ON i.command_id = root.command_id
            AND i.result = 'accepted' AND i.intent_kind = 'save_job'
            AND root.request_id = i.channel || ':' || i.transport_event_id
            AND root.owner_resource_id = i.owner_resource_id AND root.thread_id = i.thread_id
            AND root.origin_channel = i.channel AND root.origin_destination = i.origin_destination
            AND root.authorization_revision = i.authorization_revision
        )
        SELECT c.request_id AS requestId, c.canonical_job_key AS canonicalJobKey, c.canonical_url AS canonicalUrl,
          c.owner_resource_id AS ownerResourceId, c.thread_id AS threadId, c.origin_channel AS originChannel,
          c.origin_destination AS originDestination, c.authorization_revision AS authorizationRevision,
          (SELECT count(*) FROM lineage) AS lineageCount,
          (SELECT count(*) FROM lineage l JOIN career_commands ancestor ON ancestor.command_id = l.command_id
            WHERE ancestor.owner_resource_id <> c.owner_resource_id OR ancestor.thread_id <> c.thread_id
              OR ancestor.origin_channel <> c.origin_channel OR ancestor.origin_destination <> c.origin_destination
              OR ancestor.canonical_job_key <> c.canonical_job_key OR ancestor.canonical_url <> c.canonical_url) AS inconsistentCount,
          (SELECT count(*) FROM provenance) AS provenanceCount,
          (SELECT min(principal_key) FROM provenance) AS principalKey
        FROM career_commands c
        WHERE c.command_id = ? AND c.queue_state IN ('failed', 'timed_out')
      `).get(input.parentCommandId, input.parentCommandId) as { requestId: string; canonicalJobKey: string; canonicalUrl: string; ownerResourceId: string; threadId: string; originChannel: string; originDestination: string; authorizationRevision: number | null; lineageCount: number; inconsistentCount: number; provenanceCount: number; principalKey: string | null } | undefined;
      if (!parent) throw new Error('Terminal retry parent must be terminal failed or timed out.');
      if (parent.lineageCount >= 100 || parent.inconsistentCount !== 0 || parent.provenanceCount !== 1 || parent.principalKey === null) {
        throw new Error('Terminal retry lineage has no unique consistent accepted save provenance.');
      }
      if (parent.ownerResourceId !== authorization.resourceId) throw new Error('Terminal retry owner does not match the parent resource.');
      if (parent.threadId !== authorization.threadId || parent.originChannel !== authorization.channel
        || parent.originDestination !== authorization.destination || parent.principalKey !== authorization.principalKey) {
        throw new Error('Terminal retry authorization correlation does not match the accepted principal and destination.');
      }
      if (parent.authorizationRevision === null || authorization.authorizationRevision < parent.authorizationRevision) {
        throw new Error('Terminal retry authorization revision is stale or unavailable.');
      }
      const now = this.databaseNow();
      assertCurrentlyValidPrincipalAuthorizationCapability(authorization);
      this.database.prepare(`
        INSERT INTO career_commands (
          command_id, attempt_id, parent_command_id, request_id, canonical_job_key, canonical_url,
          owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision,
          queue_state, created_at, updated_at, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(input.commandId, input.attemptId, input.parentCommandId, input.requestId, parent.canonicalJobKey, parent.canonicalUrl,
        parent.ownerResourceId, parent.threadId, parent.originChannel, parent.originDestination, authorization.authorizationRevision, now, now, now);
      const child = this.database.prepare('SELECT queue_sequence AS queueSequence FROM career_commands WHERE command_id = ?').get(input.commandId) as { queueSequence: number };
      this.database.exec('COMMIT');
      return { commandId: input.commandId, queueSequence: child.queueSequence, state: 'queued' };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeClaim(fence: WorkerFence, outcome: 'succeeded' | 'failed'): WorkerWriteResult {
    if (fence.sourceState !== 'running') return { applied: false, reason: 'lease_lost' };
    const result = this.database.prepare(`
      UPDATE career_commands
      SET queue_state = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          terminal_generation = terminal_generation + 1,
          completed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
          resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
          updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE command_id = ? AND run_id = ? AND owner_resource_id = ? AND lease_owner = ?
        AND claim_generation = ? AND queue_state = 'running'
        AND lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      RETURNING updated_at AS updatedAt
    `).get(outcome, fence.commandId, fence.runId, fence.ownerResourceId, fence.leaseOwner, fence.claimGeneration) as { updatedAt: number } | undefined;
    return result ? { applied: true, updatedAt: Number(result.updatedAt) } : { applied: false, reason: 'lease_lost' };
  }

  authorizeExternalEffect(guard: WorkerFence & {
    stageKey: string;
    stageVersion: number;
    idempotencyKey: string;
    expectedSheetFingerprint: string | null;
    expectedRowVersion: number | null;
  }): { authorized: true; stageRecordId: string } | { authorized: false; reason: 'lease_lost' | 'stage_guard_failed' } {
    if (guard.sourceState !== 'running' && guard.sourceState !== 'resuming') return { authorized: false, reason: 'stage_guard_failed' };
    const authorization = this.database.prepare(`
      SELECT s.stage_record_id AS stageRecordId
      FROM career_commands c
      LEFT JOIN career_stage_journal s
        ON s.command_id = c.command_id AND s.run_id = c.run_id
        AND s.stage_key = ? AND s.stage_version = ? AND s.state = 'applying'
        AND s.idempotency_key = ? AND s.expected_sheet_fingerprint IS ? AND s.expected_row_version IS ?
      WHERE c.command_id = ? AND c.run_id = ? AND c.owner_resource_id = ? AND c.lease_owner = ?
        AND c.claim_generation = ? AND c.queue_state = ?
        AND c.lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND c.processing_deadline_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    `).get(
      guard.stageKey, guard.stageVersion, guard.idempotencyKey, guard.expectedSheetFingerprint, guard.expectedRowVersion,
      guard.commandId, guard.runId, guard.ownerResourceId, guard.leaseOwner, guard.claimGeneration, guard.sourceState,
    ) as { stageRecordId: string | null } | undefined;
    if (!authorization) return { authorized: false, reason: 'lease_lost' };
    return authorization.stageRecordId === null
      ? { authorized: false, reason: 'stage_guard_failed' }
      : { authorized: true, stageRecordId: authorization.stageRecordId };
  }

  expireProcessingDeadlines(): { transitioned: number } {
    const result = this.database.prepare(`
      UPDATE career_commands
      SET queue_state = 'timed_out', lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
          retry_due_at = NULL, blocker_id = NULL, terminal_generation = terminal_generation + 1,
          error_class = CASE WHEN legacy_retry_wait_v4 = 1 THEN error_class ELSE 'deadline' END,
          error_code = CASE WHEN legacy_retry_wait_v4 = 1 THEN error_code ELSE 'processing_deadline_expired' END,
          last_safe_error = CASE WHEN legacy_retry_wait_v4 = 1 THEN last_safe_error ELSE 'The automatic processing deadline expired.' END,
          legacy_retry_wait_v4 = 0,
          completed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
          resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE queue_state IN ('starting', 'running', 'resuming', 'retry_wait')
        AND processing_deadline_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
    `).run();
    return { transitioned: Number(result.changes) };
  }

  expireSuspensions(): { transitioned: number } {
    const now = this.databaseNow();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const ids = this.database.prepare(`
        SELECT c.command_id AS commandId, s.suspension_id AS suspensionId
        FROM career_commands c JOIN career_suspensions s
          ON s.command_id = c.command_id AND s.run_id = c.run_id AND s.generation = c.suspension_generation AND s.suspension_id = c.blocker_id
        WHERE c.queue_state = 'suspended' AND s.blocker_state = 'pending' AND s.expires_at <= ?
      `).all(now) as Array<{ commandId: string; suspensionId: string }>;
      for (const { commandId, suspensionId } of ids) {
        this.database.prepare("UPDATE career_suspensions SET blocker_state = 'expired', resolved_at = ?, updated_at = ? WHERE suspension_id = ? AND blocker_state = 'pending' AND expires_at <= ?").run(now, now, suspensionId, now);
        this.database.prepare(`
          UPDATE career_commands
          SET queue_state = 'timed_out', blocker_id = NULL, terminal_generation = terminal_generation + 1,
              error_class = 'blocker', error_code = 'suspension_expired',
              last_safe_error = 'The suspension expired before an accepted response was received.',
              completed_at = ?, resolved_at = ?, updated_at = ?
          WHERE command_id = ? AND queue_state = 'suspended' AND blocker_id = ?
        `).run(now, now, now, commandId, suspensionId);
      }
      this.database.exec('COMMIT');
      return { transitioned: ids.length };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getCommand(commandId: string): {
    commandId: string;
    queueState: QueueStateV0;
    claimGeneration: number;
    leaseOwner: string | null;
    leaseExpiresAt: number | null;
    heartbeatAt: number | null;
    processingDeadlineAt: number | null;
    retryDueAt: number | null;
    terminalGeneration: number;
    automaticRepeatsUsed: number;
    processingBudgetRemainingMs: number;
  } | undefined {
    return this.database.prepare(`
      SELECT command_id AS commandId, queue_state AS queueState, claim_generation AS claimGeneration,
        lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt, heartbeat_at AS heartbeatAt,
        processing_deadline_at AS processingDeadlineAt, retry_due_at AS retryDueAt, terminal_generation AS terminalGeneration,
        automatic_repeats_used AS automaticRepeatsUsed, processing_budget_remaining_ms AS processingBudgetRemainingMs
      FROM career_commands WHERE command_id = ?
    `).get(commandId) as ReturnType<CareerStore['getCommand']>;
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
