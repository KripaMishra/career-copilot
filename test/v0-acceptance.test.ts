import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { AgentBrowser } from '@mastra/agent-browser';
import { MessageList } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

import { OwnerAuthorization } from '../src/channels/telegram-auth.ts';
import { resolveRuntimeConfig } from '../src/config/runtime.ts';
import * as V0Contracts from '../src/contracts/v0.ts';
import { CareerStore, MIGRATIONS } from '../src/storage/career-store.ts';
import { CareerCopilotService } from '../src/services/career-copilot.ts';
import { createCareerCopilotRuntime } from '../src/services/career-runtime.ts';

const exactLegacySql = `
  CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE career_idempotency (
    key TEXT PRIMARY KEY, first_request_id TEXT NOT NULL, sightings INTEGER NOT NULL DEFAULT 0,
    last_request_id TEXT, last_source_id TEXT, state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER, error TEXT
  ) STRICT;
  CREATE TABLE career_outbox (
    request_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step)
  ) STRICT;
`;

const primaryMemoryConfig = {
  lastMessages: 20,
  generateTitle: false,
  semanticRecall: false,
  workingMemory: { enabled: false },
  observationalMemory: false,
};

const browserToolIds = [
  'browser_back',
  'browser_click',
  'browser_close',
  'browser_dialog',
  'browser_drag',
  'browser_evaluate',
  'browser_goto',
  'browser_hover',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_select',
  'browser_snapshot',
  'browser_tabs',
  'browser_type',
  'browser_wait',
];

type AcceptanceRow = {
  id: string;
  run: () => Promise<void> | void;
};

function runNode(program: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', program], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(0) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

function withMigratedDatabase(run: (databasePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-focused-'));
  const databasePath = path.join(dir, 'operational.db');
  try {
    const store = new CareerStore(`file:${databasePath}`);
    store.close();
    run(databasePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rejects case-tampered enum literals in an otherwise valid ledger schema without mutating it', () => {
  withMigratedDatabase((databasePath) => {
    const database = new DatabaseSync(databasePath);
    database.exec("INSERT INTO career_requests VALUES ('keep-me')");
    database.enableDefensive(false);
    database.exec('PRAGMA writable_schema = ON');
    database.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = 'table' AND name = 'career_turn_inbox'").run("'ordinary_reply'", "'Ordinary_reply'");
    database.exec('PRAGMA writable_schema = OFF');
    database.close();
    const before = databaseSnapshot(databasePath);
    assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
    assert.deepEqual(databaseSnapshot(databasePath), before);
  });
});

test('rejects quoted-literal whitespace tampering that does not alter SQL structure', () => {
  withMigratedDatabase((databasePath) => {
    const database = new DatabaseSync(databasePath);
    database.enableDefensive(false);
    database.exec('PRAGMA writable_schema = ON');
    database.prepare("UPDATE sqlite_schema SET sql = replace(sql, ?, ?) WHERE type = 'trigger' AND name = 'career_outbox_rendering_immutable'").run(
      "'rendered delivery is immutable'",
      "'rendered  delivery is immutable'",
    );
    database.exec('PRAGMA writable_schema = OFF');
    database.close();
    assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
  });
});

test('migrates exact legacy career tables alongside pre-existing Mastra objects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-mastra-legacy-'));
  const databasePath = path.join(dir, 'operational.db');
  try {
    const mastraStorage = new LibSQLStore({ id: 'legacy-coexistence', url: `file:${databasePath}` });
    await mastraStorage.init();
    await mastraStorage.close();
    const database = new DatabaseSync(databasePath);
    database.exec(exactLegacySql);
    database.exec("INSERT INTO career_requests VALUES ('legacy-request'); INSERT INTO career_outbox VALUES ('legacy-request','report','succeeded','{}',1)");
    database.close();

    const store = new CareerStore(`file:${databasePath}`);
    assert.deepEqual(store.migrationStatus(), { currentVersion: MIGRATIONS.length, verified: true });
    store.close();
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(upgraded.prepare("SELECT count(*) AS count FROM career_requests WHERE request_id='legacy-request'").get()!.count, 1);
    assert.equal(upgraded.prepare("SELECT count(*) AS count FROM career_outbox WHERE request_id='legacy-request'").get()!.count, 1);
    assert.ok((upgraded.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'mastra_%' LIMIT 1").get()));
    upgraded.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects unknown unledgered legacy damage without changing schema or data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-recognize-'));
  const databasePath = path.join(dir, 'operational.db');
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE career_requests (request_id TEXT PRIMARY KEY, injected TEXT) STRICT; INSERT INTO career_requests(request_id, injected) VALUES ('keep-me', 'unchanged');");
    const before = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    database.close();
    assert.throws(() => new CareerStore(`file:${databasePath}`), /unrecognized|verification/i);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(after.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), before);
    assert.deepEqual(after.prepare('SELECT * FROM career_requests').all().map((row) => ({ ...row })), [{ request_id: 'keep-me', injected: 'unchanged' }]);
    after.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects injected managed-table triggers', () => {
  withMigratedDatabase((databasePath) => {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER career_injected_trigger AFTER INSERT ON career_requests BEGIN SELECT 1; END;");
    database.close();
    assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
  });
});

test('enforces run provenance and suspension-envelope blocker linkage', () => {
  withMigratedDatabase((databasePath) => {
    const db = new DatabaseSync(databasePath);
    const hash = `sha256:${'a'.repeat(64)}`;
    db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, processing_started_at, suspension_generation, blocker_id, created_at, updated_at, queued_at) VALUES ('c1','a1','r1','job','https://example.com/job','owner','thread','telegram','chat','suspended','run-1','dispatched',20,1,'blocker-1',10,20,10)");
    assert.throws(() => db.exec("INSERT INTO career_stage_journal (stage_record_id, command_id, run_id, stage_key, stage_version, state, idempotency_key, created_at, updated_at) VALUES ('bad-stage','c1','wrong-run','acquire',1,'planned','bad-stage-key',20,20)"), /constraint/i);
    assert.throws(() => db.prepare("INSERT INTO career_suspensions (suspension_id, command_id, run_id, suspended_step, blocker_kind, blocker_state, blocker_schema_version, generation, safe_payload, payload_hash, source_hash, profile_hash, prompt_version, prompt_hash, resume_schema_version, resume_schema_hash, allowed_response, issued_at, expires_at, created_at, updated_at) VALUES ('wrong-run-blocker','c1','wrong-run','acquire','reauth_required','pending',1,1,'{}',?,?,?,1,?,1,?,'{}',20,40,20,20)").run(hash, hash, hash, hash, hash), /constraint/i);
    db.prepare("INSERT INTO career_suspensions (suspension_id, command_id, run_id, suspended_step, blocker_kind, blocker_state, blocker_schema_version, generation, safe_payload, payload_hash, source_hash, profile_hash, prompt_version, prompt_hash, resume_schema_version, resume_schema_hash, allowed_response, issued_at, expires_at, created_at, updated_at) VALUES ('blocker-1','c1','run-1','acquire','reauth_required','pending',1,1,'{}',?,?,?,1,?,1,?,'{}',20,40,20,20)").run(hash, hash, hash, hash, hash);
    const completion = fixture(contractFixtures(V0Contracts), 'CompletionEnvelopeV1Schema');
    const envelope = (envelopeId: string, runId: string, generation: number, blockerId: string) => JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({
      ...suspensionEnvelope(completion), envelopeId, commandId: 'c1', runId, suspensionGeneration: generation,
      blocker: { ...suspensionEnvelope(completion).blocker, blockerId },
    }));
    db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, suspension_generation, suspension_id, envelope_json, state, created_at, updated_at) VALUES ('env-good','c1','run-1','suspension',1,'blocker-1',?,'pending',20,20)").run(envelope('env-good', 'run-1', 1, 'blocker-1'));
    for (const [id, runId, generation, blockerId] of [['bad-run', 'wrong-run', 1, 'blocker-1'], ['bad-generation', 'run-1', 2, 'blocker-1'], ['bad-blocker', 'run-1', 1, 'other-blocker']] as const) {
      assert.throws(() => db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, suspension_generation, suspension_id, envelope_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'pending',20,20)").run(id, 'c1', runId, 'suspension', generation, blockerId, envelope(id, runId, generation, blockerId)), /constraint/i);
    }
    db.close();
  });
});

const task5Owner = {
  resourceId: 'owner-v0', enabled: true, authorizationRevision: 1,
  telegram: { userIds: new Set(['123', '124']), privateChatIds: new Set(['456']) },
  studioEnabled: true, stdioEnabled: true,
};
const task5Update = (id: number, text = '/save https://linkedin.com/jobs/1', userId = 123) => ({
  update_id: id,
  message: { message_id: id + 1, date: 1, from: { id: userId, is_bot: false }, chat: { id: 456, type: 'private' }, text },
});
function withTask5(run: (fixture: { store: CareerStore; secondStore: CareerStore; service: CareerCopilotService; secondService: CareerCopilotService; databasePath: string }) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-task5-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const secondStore = new CareerStore(`file:${databasePath}`);
  const service = (target: CareerStore) => new CareerCopilotService({ authorization: new OwnerAuthorization(() => task5Owner), store: target, intakeHashKey: 'k'.repeat(32) });
  return Promise.resolve(run({ store, secondStore, service: service(store), secondService: service(secondStore), databasePath }))
    .finally(() => { secondStore.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

const rows: AcceptanceRow[] = [
  {
    id: 'P4-telegram-user-and-private-chat',
    run: () => {
      let current = task5Owner;
      const auth = new OwnerAuthorization(() => current);
      const binding = auth.authorize({ channel: 'telegram', userId: '123', chatId: '456', privateChat: true });
      assert.equal(binding.threadId, 'telegram:456');
      assert.throws(() => auth.authorize({ channel: 'telegram', userId: '124', chatId: '999', privateChat: true }), /unauthorized/i);
      for (const boundary of ['delivery', 'effect'] as const) {
        assert.deepEqual(auth.reauthorize(binding, boundary), binding);
        assert.throws(() => auth.reauthorize({ ...binding, destination: '999' }, boundary), /revoked|unauthorized/i);
      }
      current = { ...task5Owner, telegram: { ...task5Owner.telegram, userIds: new Set(['124']) } };
      for (const boundary of ['delivery', 'effect'] as const) assert.throws(() => auth.reauthorize(binding, boundary), /revoked|unauthorized/i);
    },
  },
  {
    id: 'P4-cross-principal-denied',
    run: () => {
      const auth = new OwnerAuthorization(() => task5Owner);
      const stored = auth.authorize({ channel: 'telegram', userId: '123', chatId: '456', privateChat: true });
      const studio = { channel: 'studio' as const, remoteAddress: '127.0.0.1', conversationId: '456' };
      assert.equal(auth.authorize(studio).resourceId, stored.resourceId);
      for (const boundary of ['enqueue', 'read', 'resume'] as const) assert.throws(() => auth.reauthorize(stored, boundary, studio), /unauthorized/i);
    },
  },
  {
    id: 'P4-studio-ui-loopback-owner',
    run: () => {
      const auth = new OwnerAuthorization(() => task5Owner);
      const binding = auth.authorize({ channel: 'studio', remoteAddress: '::1', conversationId: 'one' });
      assert.equal(binding.threadId, 'studio:one');
      assert.throws(() => auth.authorize({ channel: 'studio', remoteAddress: '192.0.2.1', conversationId: 'one' }), /unauthorized/i);
      for (const boundary of ['delivery', 'effect'] as const) {
        for (const forged of [{ ...binding, destination: 'forged' }, { ...binding, threadId: 'forged' }, { ...binding, principalKey: 'forged' }]) {
          assert.throws(() => auth.reauthorize(forged, boundary), /unauthorized|revoked/i);
        }
      }
    },
  },
  {
    id: 'P4-stdio-configured-local-owner',
    run: () => {
      const auth = new OwnerAuthorization(() => task5Owner);
      const binding = auth.authorize({ channel: 'stdio' });
      assert.equal(binding.resourceId, 'owner-v0');
      for (const boundary of ['delivery', 'effect'] as const) {
        for (const forged of [{ ...binding, destination: 'forged' }, { ...binding, threadId: 'forged' }, { ...binding, principalKey: 'forged' }]) {
          assert.throws(() => auth.reauthorize(forged, boundary), /unauthorized|revoked/i);
        }
      }
    },
  },
  {
    id: 'P4-api-disabled-until-authenticated-binding',
    run: () => {
      assert.throws(() => new OwnerAuthorization(() => task5Owner).authorize({ channel: 'api', authenticatedIdentity: 'owner', conversationId: 'one' }), /disabled/i);
      const auth = new OwnerAuthorization(() => ({ ...task5Owner, apiIdentity: 'api-owner' }));
      const binding = auth.authorize({ channel: 'api', authenticatedIdentity: 'api-owner', conversationId: 'one' });
      assert.equal(binding.principalKey, 'api:api-owner:one');
      for (const boundary of ['delivery', 'effect'] as const) {
        for (const forged of [{ ...binding, destination: 'forged' }, { ...binding, threadId: 'forged' }, { ...binding, principalKey: 'forged' }]) {
          assert.throws(() => auth.reauthorize(forged, boundary), /unauthorized|revoked/i);
        }
        assert.throws(() => auth.reauthorize({ ...binding, channel: 'unknown' as 'api' }, boundary), /unauthorized|revoked/i);
      }
    },
  },
  {
    id: 'P4-forged-resource-thread-ignored',
    run: () => withTask5(async ({ service, databasePath }) => {
      const result = await service.process({ ...task5Update(1), resourceId: 'attacker', threadId: 'attacker' });
      assert.equal(result.outcome, 'enqueued');
      const db = new DatabaseSync(databasePath, { readOnly: true });
      assert.deepEqual({ ...db.prepare('SELECT owner_resource_id owner, thread_id thread FROM career_commands').get() }, { owner: 'owner-v0', thread: 'telegram:456' });
      db.close();
      for (const inaccessible of ['dependencies', 'hashKey', 'payloadHash', 'store', 'processTrustedTransport', 'processTransport']) {
        assert.equal(inaccessible in service, false, `${inaccessible} must not be runtime-accessible`);
      }
    }),
  },
  {
    id: 'P13-duplicate-transport-event-one-intent',
    run: () => withTask5(async ({ service, secondService, store }) => {
      const [first, second] = await Promise.all([service.process(task5Update(2)), secondService.process(task5Update(2))]);
      assert.equal(first.outcome, 'enqueued'); assert.equal(second.outcome, 'enqueued');
      if (first.outcome !== 'enqueued' || second.outcome !== 'enqueued') return;
      assert.equal(first.commandId, second.commandId); assert.equal(store.getCommandCount(), 1);
    }),
  },
  {
    id: 'P13-enqueue-before-ack',
    run: async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-ack-'));
      const config = resolveRuntimeConfig({ dataDir: root, env: { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0', CAREER_COPILOT_INTAKE_HASH_KEY: 'k'.repeat(32), TELEGRAM_ALLOWED_USER_IDS: '123', CAREER_COPILOT_PRIVATE_CHAT_IDS: '456', GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet' } });
      const runtime = createCareerCopilotRuntime(config);
      try {
        const observed: number[] = [];
        await runtime.handleTelegramUpdate(task5Update(3), async () => { observed.push(runtime.store.getCommandCount()); });
        assert.deepEqual(observed, [1]);
        runtime.store.recordInboundAndEnqueue = () => { throw new Error('rollback'); };
        let replied = false;
        await assert.rejects(() => runtime.handleTelegramUpdate(task5Update(4), async () => { replied = true; }), /rollback/);
        assert.equal(replied, false);
      } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    id: 'P13-two-save-commands-preserve-order',
    run: () => withTask5(async ({ service, secondService, databasePath }) => {
      const results = await Promise.all([secondService.process(task5Update(11, '/save https://linkedin.com/jobs/11/?src=task%2F5')), service.process(task5Update(10, '/save https://linkedin.com/jobs/10'))]);
      assert.deepEqual(results.map((result) => result.outcome), ['enqueued', 'enqueued']);
      assert.deepEqual(results.map((result) => result.outcome === 'enqueued' ? result.queueSequence : 0), [1, 2]);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const stored = database.prepare('SELECT command_id commandId, queue_sequence queueSequence, canonical_url canonicalUrl FROM career_commands ORDER BY queue_sequence').all().map((row) => ({ ...row }));
      database.close();
      assert.deepEqual(stored, [
        { commandId: results[0].outcome === 'enqueued' ? results[0].commandId : '', queueSequence: 1, canonicalUrl: 'https://linkedin.com/jobs/11?src=task%2F5' },
        { commandId: results[1].outcome === 'enqueued' ? results[1].commandId : '', queueSequence: 2, canonicalUrl: 'https://linkedin.com/jobs/10' },
      ]);
    }),
  },
  {
    id: 'scope-job-command-parked',
    run: () => withTask5(async ({ service, store }) => {
      const result = await service.process(task5Update(20, '/job https://linkedin.com/jobs/20'));
      assert.deepEqual({ outcome: result.outcome, command: result.outcome === 'parked' ? result.command : undefined, duplicate: result.outcome === 'parked' ? result.duplicate : undefined },
        { outcome: 'parked', command: 'job', duplicate: false });
      assert.equal(store.getCommandCount(), 0);
    }),
  },
  {
    id: 'privacy-raw-update-not-retained',
    run: () => withTask5(async ({ service, databasePath }) => {
      await service.process({ ...task5Update(30), message: { ...task5Update(30).message, first_name: 'RAW_CANARY' } });
      const db = new DatabaseSync(databasePath, { readOnly: true });
      const retained = JSON.stringify(db.prepare('SELECT * FROM career_inbound_events').all()); db.close();
      assert.equal(retained.includes('RAW_CANARY'), false); assert.equal(retained.includes('/save'), false);
    }),
  },
  {
    id: 'P18-empty-migration',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-migration-'));
      const databasePath = path.join(dir, 'operational.db');
      try {
        const store = new CareerStore(`file:${databasePath}`);
        assert.deepEqual(store.migrationStatus(), { currentVersion: MIGRATIONS.length, verified: true });
        store.close();

        const database = new DatabaseSync(databasePath, { readOnly: true });
        const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
        for (const table of [
          'schema_migrations', 'career_inbound_events', 'career_commands', 'career_stage_journal',
          'career_suspensions', 'career_evidence_records', 'career_completion_outbox', 'career_deliveries',
          'career_turn_inbox', 'career_structured_events', 'career_deletion_tombstones',
        ]) assert.ok(tables.includes(table), `missing ${table}`);
        assert.equal(tables.includes('career_outbox'), false);
        const indexes = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(({ name }) => name);
        for (const index of [
          'career_commands_fifo_idx', 'career_commands_retry_due_idx', 'career_commands_lease_expiry_idx', 'career_commands_retention_idx',
          'career_stage_retention_idx', 'career_suspensions_retention_idx', 'career_outbox_pending_delivery_idx',
          'career_outbox_lease_expiry_idx', 'career_outbox_retention_idx', 'career_deliveries_due_work_idx',
          'career_deliveries_claim_expiry_idx', 'career_deliveries_retention_idx',
          'career_turn_inbox_fifo_idx', 'career_turn_inbox_lease_expiry_idx', 'career_evidence_retention_idx',
          'career_structured_events_retention_idx',
        ]) assert.ok(indexes.includes(index), `missing ${index}`);
        assert.equal(indexes.includes('career_commands_terminal_immutable'), false);
        const fifo = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'career_commands_fifo_idx'").get() as { sql: string };
        assert.match(fifo.sql, /\(queue_state, queue_sequence\)/);
        const commandColumns = (database.prepare('PRAGMA table_info(career_commands)').all() as Array<{ name: string }>).map(({ name }) => name);
        for (const column of ['queue_sequence', 'workflow_attempt', 'processing_started_at', 'retention_deadline_at', 'authorization_revision']) assert.ok(commandColumns.includes(column), `missing command.${column}`);
        const deliveryColumns = (database.prepare('PRAGMA table_info(career_deliveries)').all() as Array<{ name: string }>).map(({ name }) => name);
        for (const column of ['source_kind', 'envelope_id', 'turn_delivery_id', 'claim_generation', 'claim_owner', 'claim_expires_at', 'heartbeat_at', 'attempt_count', 'first_attempt_at', 'next_attempt_at', 'retry_deadline_at', 'provider', 'provider_outcome', 'retention_deadline_at']) assert.ok(deliveryColumns.includes(column), `missing delivery.${column}`);
        for (const table of ['career_stage_journal', 'career_suspensions', 'career_evidence_records', 'career_completion_outbox', 'career_deliveries']) {
          assert.ok(database.prepare(`PRAGMA foreign_key_list(${table})`).all().length > 0, `missing foreign key on ${table}`);
        }
        const ledger = (database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string; checksum: string }>).map((row) => ({ ...row }));
        assert.deepEqual(ledger, MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum })));
        for (const migration of MIGRATIONS) {
          assert.equal(createHash('sha256').update(migration.sql).digest('hex'), migration.checksum);
        }
        database.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P18-populated-v2-to-v3-preserves-correlations',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-v2-preservation-'));
      const databasePath = path.join(dir, 'operational.db');
      const expectedPath = path.join(dir, 'expected-v3.db');
      try {
        const hash = `sha256:${'a'.repeat(64)}`;
        const completion = fixture(contractFixtures(V0Contracts), 'CompletionEnvelopeV1Schema');
        const envelope = JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({
          ...suspensionEnvelope(completion), envelopeId: 'v2-envelope', commandId: 'v2-command', runId: 'v2-run',
          blocker: { ...suspensionEnvelope(completion).blocker, blockerId: 'v2-suspension' },
        }));
        const terminalEnvelope = JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({
          ...completion, envelopeId: 'v2-terminal-envelope', commandId: 'v2-parent-command', runId: 'v2-parent-run', terminalGeneration: 1,
        }));
        const database = new DatabaseSync(databasePath);
        database.exec(exactLegacySql);
        database.exec(MIGRATIONS[0].sql);
        database.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL CHECK (length(checksum) = 64), applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
            legacy_outbox_preserved INTEGER NOT NULL CHECK (legacy_outbox_preserved IN (0, 1) AND (version = 1 OR legacy_outbox_preserved = 0))
          ) STRICT;
        `);
        database.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?, 1, 1)').run(MIGRATIONS[0].name, MIGRATIONS[0].checksum);
        database.exec(MIGRATIONS[1].sql);
        database.prepare('INSERT INTO schema_migrations VALUES (2, ?, ?, 2, 0)').run(MIGRATIONS[1].name, MIGRATIONS[1].checksum);
        database.exec("INSERT INTO career_commands (command_id,attempt_id,request_id,canonical_job_key,canonical_url,owner_resource_id,thread_id,origin_channel,origin_destination,queue_state,run_id,start_dispatch_state,processing_started_at,processing_deadline_at,terminal_generation,created_at,updated_at,queued_at,completed_at,resolved_at) VALUES ('v2-parent-command','v2-parent-attempt','v2-parent-request','job:v2-parent','https://example.com/v2-parent','v2-owner','v2-thread','telegram','v2-chat','failed','v2-parent-run','not_dispatched',2,100,1,1,3,1,3,3)");
        database.exec("INSERT INTO career_commands (command_id,attempt_id,parent_command_id,request_id,canonical_job_key,canonical_url,owner_resource_id,thread_id,origin_channel,origin_destination,queue_state,run_id,start_dispatch_state,processing_started_at,suspension_generation,blocker_id,created_at,updated_at,queued_at) VALUES ('v2-command','v2-attempt','v2-parent-command','v2-request','job:v2','https://example.com/v2','v2-owner','v2-thread','telegram','v2-chat','suspended','v2-run','dispatched',2,1,'v2-suspension',1,2,1)");
        database.exec("INSERT INTO career_stage_journal (stage_record_id,command_id,run_id,stage_key,stage_version,state,idempotency_key,created_at,updated_at) VALUES ('v2-stage','v2-command','v2-run','acquire',1,'planned','v2-stage-key',2,2)");
        database.prepare("INSERT INTO career_suspensions (suspension_id,command_id,run_id,suspended_step,blocker_kind,blocker_state,blocker_schema_version,generation,safe_payload,payload_hash,source_hash,profile_hash,prompt_version,prompt_hash,resume_schema_version,resume_schema_hash,allowed_response,issued_at,expires_at,created_at,updated_at) VALUES ('v2-suspension','v2-command','v2-run','acquire','reauth_required','pending',1,1,'{}',?,?,?,1,?,1,?,'{}',2,100,2,2)").run(hash, hash, hash, hash, hash);
        database.prepare("INSERT INTO career_completion_outbox (envelope_id,command_id,run_id,envelope_kind,suspension_generation,suspension_id,envelope_json,state,created_at,updated_at) VALUES ('v2-envelope','v2-command','v2-run','suspension',1,'v2-suspension',?,'pending',2,2)").run(envelope);
        database.prepare("INSERT INTO career_completion_outbox (envelope_id,command_id,run_id,envelope_kind,terminal_generation,envelope_json,state,created_at,updated_at) VALUES ('v2-terminal-envelope','v2-parent-command','v2-parent-run','terminal',1,?,'pending',3,3)").run(terminalEnvelope);
        database.exec("INSERT INTO career_deliveries (delivery_id,delivery_key,source_kind,envelope_id,source_command_id,source_run_id,destination_channel,destination_id,owner_resource_id,thread_id,origin_channel,origin_destination,authorization_revision,state,retry_deadline_at,created_at,updated_at) VALUES ('v2-delivery','v2-delivery-key','completion','v2-envelope','v2-command','v2-run','telegram','v2-chat','v2-owner','v2-thread','telegram','v2-chat',0,'pending',100,2,2)");
        database.prepare("INSERT INTO career_evidence_records (evidence_id,command_id,source_url,acquisition_method,acquired_at,bounded_spans,bounded_excerpts,source_hash,source_version,profile_hash,profile_version,retention_deadline_at,created_at) VALUES ('v2-evidence','v2-command','https://example.com/v2','direct_fetch',2,'[]','[]',?,'v1',?,'v1',100,2)").run(hash, hash);
        database.exec("INSERT INTO career_structured_events (event_id,event_kind,owner_resource_id,command_id,safe_fields,occurred_at,retention_deadline_at) VALUES ('v2-event','audit','v2-owner','v2-command','{}',2,100)");
        const tables = ['career_commands', 'career_stage_journal', 'career_suspensions', 'career_completion_outbox', 'career_deliveries', 'career_evidence_records', 'career_structured_events'];
        const before = Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row }))]));
        database.close();

        const store = new CareerStore(`file:${databasePath}`);
        store.close();
        const expectedStore = new CareerStore(`file:${expectedPath}`);
        expectedStore.close();
        const upgraded = new DatabaseSync(databasePath, { readOnly: true });
        const expected = new DatabaseSync(expectedPath, { readOnly: true });
        for (const table of tables) {
          const expectedRows = table === 'career_commands'
            ? (before[table] as Array<Record<string, unknown>>).map((row) => ({ ...row, authorization_revision: null }))
            : before[table];
          assert.deepEqual(upgraded.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })), expectedRows, table);
        }
        const v3ObjectsSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (name LIKE 'career_%' OR tbl_name LIKE 'career_%') AND name <> 'career_outbox' AND tbl_name <> 'career_outbox' ORDER BY type,name";
        assert.deepEqual(
          upgraded.prepare(v3ObjectsSql).all().map((row) => ({ ...row })),
          expected.prepare(v3ObjectsSql).all().map((row) => ({ ...row })),
        );
        assert.deepEqual(upgraded.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })), MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum })));
        assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal((upgraded.prepare("SELECT parent_command_id FROM career_commands WHERE command_id = 'v2-command'").get() as { parent_command_id: string }).parent_command_id, 'v2-parent-command');
        const commandForeignKeys = upgraded.prepare('PRAGMA foreign_key_list(career_commands)').all() as Array<{ table: string; from: string; to: string }>;
        assert.ok(commandForeignKeys.some((foreignKey) => foreignKey.table === 'career_commands' && foreignKey.from === 'parent_command_id' && foreignKey.to === 'command_id'));
        const outboxForeignKeys = upgraded.prepare('PRAGMA foreign_key_list(career_completion_outbox)').all() as Array<{ id: number; seq: number; table: string; from: string; to: string }>;
        const terminalForeignKeyId = outboxForeignKeys.find((foreignKey) => foreignKey.table === 'career_commands' && foreignKey.from === 'terminal_generation' && foreignKey.to === 'terminal_generation')?.id;
        assert.notEqual(terminalForeignKeyId, undefined);
        assert.deepEqual(
          outboxForeignKeys.filter((foreignKey) => foreignKey.id === terminalForeignKeyId).sort((left, right) => left.seq - right.seq).map(({ from, to }) => ({ from, to })),
          [
            { from: 'command_id', to: 'command_id' },
            { from: 'run_id', to: 'run_id' },
            { from: 'terminal_generation', to: 'terminal_generation' },
          ],
        );
        upgraded.close();
        expected.close();
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    id: 'P18-interrupted-migration-retry',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-interrupted-'));
      const databasePath = path.join(dir, 'operational.db');
      try {
        const database = new DatabaseSync(databasePath);
        database.exec(exactLegacySql);
        database.exec("INSERT INTO career_requests VALUES ('request-a'); INSERT INTO career_idempotency VALUES ('bad','request-a',-1,NULL,NULL,'pending',NULL,NULL); INSERT INTO career_outbox VALUES ('request-a','report','pending','{}',1)");
        database.close();
        const before = databaseSnapshot(databasePath);

        assert.throws(() => new CareerStore(`file:${databasePath}`), /constraint/i);
        assert.deepEqual(databaseSnapshot(databasePath), before, 'failed migration must roll back ledger, schema, and rows');

        const repair = new DatabaseSync(databasePath);
        repair.exec("UPDATE career_idempotency SET sightings=0 WHERE key='bad'");
        repair.close();
        const store = new CareerStore(`file:${databasePath}`);
        assert.deepEqual(store.migrationStatus(), { currentVersion: MIGRATIONS.length, verified: true });
        store.close();
        const upgraded = new DatabaseSync(databasePath, { readOnly: true });
        assert.equal(upgraded.prepare("SELECT sightings FROM career_idempotency WHERE key='bad'").get()!.sightings, 0);
        assert.equal(upgraded.prepare("SELECT count(*) AS count FROM career_outbox").get()!.count, 1);
        assert.equal(upgraded.prepare("SELECT count(*) AS count FROM schema_migrations").get()!.count, MIGRATIONS.length);
        upgraded.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P18-ledger-and-installed-schema-guards',
    run: () => {
      const makeDatabase = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-schema-guard-'));
        const databasePath = path.join(dir, 'operational.db');
        const store = new CareerStore(`file:${databasePath}`);
        store.close();
        return { dir, databasePath };
      };
      for (const mutate of [
        (db: DatabaseSync) => db.exec('DROP TABLE career_deletion_tombstones'),
        (db: DatabaseSync) => db.exec('DROP INDEX career_commands_fifo_idx'),
        (db: DatabaseSync) => db.exec('DROP TRIGGER career_outbox_rendering_immutable'),
        (db: DatabaseSync) => db.exec('ALTER TABLE career_deliveries RENAME COLUMN authorization_revision TO authorization_revision_broken'),
      ]) {
        const { dir, databasePath } = makeDatabase();
        try {
          const database = new DatabaseSync(databasePath); mutate(database); database.close();
          assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      for (const versionRows of [
        [{ version: 99, name: 'future', checksum: '0'.repeat(64) }],
        [{ version: 2, name: MIGRATIONS[1].name, checksum: MIGRATIONS[1].checksum }],
      ]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-ledger-'));
        const databasePath = path.join(dir, 'operational.db');
        try {
          const database = new DatabaseSync(databasePath);
          database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL CHECK (length(checksum) = 64), applied_at INTEGER NOT NULL CHECK (applied_at >= 0), legacy_outbox_preserved INTEGER NOT NULL CHECK (legacy_outbox_preserved IN (0, 1) AND (version = 1 OR legacy_outbox_preserved = 0))) STRICT;');
          for (const row of versionRows) database.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, 0)').run(row.version, row.name, row.checksum, Date.now());
          database.close();
          assert.throws(() => new CareerStore(`file:${databasePath}`), /unsupported schema migration version/i);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    },
  },
  {
    id: 'P18-concurrent-migrators',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-concurrent-'));
      const databasePath = path.join(dir, 'operational.db');
      try {
        const moduleUrl = new URL('../src/storage/career-store.ts', import.meta.url).href;
        const program = `import { CareerStore } from ${JSON.stringify(moduleUrl)}; const store = new CareerStore(${JSON.stringify(`file:${databasePath}`)}); store.close();`;
        const results = await Promise.all([runNode(program), runNode(program)]);
        assert.deepEqual(results, [0, 0]);
        const store = new CareerStore(`file:${databasePath}`);
        assert.deepEqual(store.migrationStatus(), { currentVersion: MIGRATIONS.length, verified: true });
        store.close();

        const toctouDatabasePath = path.join(dir, 'toctou-operational.db');
        const toctouReadyPath = path.join(dir, 'toctou-ready');
        const toctouGoPath = path.join(dir, 'toctou-go');
        new DatabaseSync(toctouDatabasePath).close();
        const toctouProgram = `
          import fs from 'node:fs';
          import { DatabaseSync } from 'node:sqlite';
          const prepare = DatabaseSync.prototype.prepare;
          let gated = false;
          DatabaseSync.prototype.prepare = function (sql) {
            if (!gated && sql === "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'") {
              gated = true;
              const result = prepare.call(this, sql).get();
              fs.writeFileSync(${JSON.stringify(toctouReadyPath)}, '');
              while (!fs.existsSync(${JSON.stringify(toctouGoPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              return { get: () => result };
            }
            return prepare.call(this, sql);
          };
          const { CareerStore } = await import(${JSON.stringify(moduleUrl)});
          const store = new CareerStore(${JSON.stringify(`file:${toctouDatabasePath}`)});
          store.close();
        `;
        const toctouChild = runNode(toctouProgram);
        await waitFor(() => fs.existsSync(toctouReadyPath), 'TOCTOU migration child did not become ready');
        const toctouPeer = runNode(program.replaceAll(databasePath, toctouDatabasePath));
        await delay(250);
        fs.writeFileSync(toctouGoPath, '');
        await Promise.all([toctouChild, toctouPeer]);

        const lockedDatabasePath = path.join(dir, 'locked-operational.db');
        const readyPath = path.join(dir, 'child-ready');
        const goPath = path.join(dir, 'child-go');
        const lock = new DatabaseSync(lockedDatabasePath);
        lock.exec('BEGIN EXCLUSIVE; CREATE TABLE startup_lock (value INTEGER) STRICT;');
        const lockedProgram = `
          import fs from 'node:fs';
          import { setTimeout as delay } from 'node:timers/promises';
          import { CareerStore } from ${JSON.stringify(moduleUrl)};
          fs.writeFileSync(${JSON.stringify(readyPath)}, '');
          while (!fs.existsSync(${JSON.stringify(goPath)})) await delay(10);
          const store = new CareerStore(${JSON.stringify(`file:${lockedDatabasePath}`)});
          store.close();
        `;
        const child = runNode(lockedProgram);
        await waitFor(() => fs.existsSync(readyPath), 'concurrent migration child did not become ready');
        fs.writeFileSync(goPath, '');
        await delay(250);
        lock.exec('ROLLBACK');
        lock.close();
        await child;

        const migrated = new CareerStore(`file:${lockedDatabasePath}`);
        assert.deepEqual(migrated.migrationStatus(), { currentVersion: MIGRATIONS.length, verified: true });
        migrated.close();
        const verified = new DatabaseSync(lockedDatabasePath, { readOnly: true });
        assert.deepEqual(
          verified.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })),
          MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum })),
        );
        verified.close();
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    id: 'P18-static-storage-invariants',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-static-'));
      const databasePath = path.join(dir, 'operational.db');
      try {
        const store = new CareerStore(`file:${databasePath}`); store.close();
        const db = new DatabaseSync(databasePath);
        const hash = `sha256:${'a'.repeat(64)}`;
        assert.throws(() => db.prepare("INSERT INTO career_inbound_events (event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, created_at) VALUES ('e1','telegram','t1',?,'owner','accepted',1)").run('a'.repeat(64)), /constraint/i);
        db.prepare("INSERT INTO career_inbound_events (event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, created_at) VALUES ('e1','telegram','t1',?,'owner','accepted',1)").run(hash);
        assert.throws(() => db.prepare("INSERT INTO career_inbound_events (event_id,channel,transport_event_id,normalized_hash,owner_resource_id,result,created_at,intent_kind,canonical_url,thread_id,origin_destination,principal_key) VALUES ('bad-save','telegram','bad',?,'owner','accepted',1,'save_job','https://linkedin.com/jobs/1','telegram:2','2','telegram:1:2')").run(hash), /invalid normalized/i);
        for (const sql of [
          "UPDATE career_inbound_events SET result='rejected' WHERE event_id='e1'",
          "UPDATE career_inbound_events SET rejection_reason='changed' WHERE event_id='e1'",
          "UPDATE career_inbound_events SET created_at=2 WHERE event_id='e1'",
        ]) assert.throws(() => db.exec(sql), /immutable/i);
        const insertCommand = db.prepare("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, created_at, updated_at, queued_at) VALUES (?, ?, ?, 'job','https://example.com/job','owner','thread','telegram','chat','queued',10,10,20)");
        insertCommand.run('c1', 'a1', 'r1'); insertCommand.run('c2', 'a2', 'r2');
        assert.throws(() => db.exec("INSERT INTO career_commands (queue_sequence, command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, created_at, updated_at, queued_at) VALUES (99,'forged','forged-attempt','forged-request','job','https://example.com/job','owner','thread','telegram','chat','queued',10,10,20)"), /database-assigned/i);
        assert.deepEqual((db.prepare('SELECT command_id FROM career_commands ORDER BY queue_sequence').all() as Array<{ command_id: string }>).map(({ command_id }) => command_id), ['c1', 'c2']);
        assert.throws(() => db.exec("UPDATE career_commands SET run_id='run' WHERE command_id='c1'"), /constraint/i);
        assert.throws(() => db.prepare("INSERT INTO career_deliveries (delivery_id, delivery_key, source_kind, envelope_id, turn_delivery_id, destination_channel, destination_id, owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision, state, retry_deadline_at, created_at, updated_at) VALUES ('d1','key-invalid','turn','envelope','turn','telegram','chat','owner','thread','telegram','chat',0,'pending',100,1,1)").run(), /constraint/i);
        db.prepare("INSERT INTO career_deliveries (delivery_id, delivery_key, source_kind, turn_delivery_id, destination_channel, destination_id, owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision, state, retry_deadline_at, created_at, updated_at) VALUES ('d1','key-1','turn','turn-1','telegram','chat','owner','thread','telegram','chat',0,'pending',100,1,1)").run();
        assert.throws(() => db.exec("UPDATE career_deliveries SET rendered_bytes=x'01', rendered_hash='sha256:" + 'b'.repeat(64) + "' WHERE delivery_id='d1'"), /constraint/i);
        db.exec("UPDATE career_deliveries SET state='claimed', claim_generation=1, claim_owner='dispatcher', claim_expires_at=20, heartbeat_at=2 WHERE delivery_id='d1'");
        assert.equal((db.prepare("SELECT rendered_bytes FROM career_deliveries WHERE delivery_id='d1'").get() as { rendered_bytes: null }).rendered_bytes, null);
        assert.throws(() => db.exec("UPDATE career_commands SET retention_deadline_at=100 WHERE command_id='c1'"), /constraint/i);

        db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, processing_started_at, processing_deadline_at, terminal_generation, created_at, updated_at, queued_at, completed_at, resolved_at) VALUES ('c3','a3','r3','job3','https://example.com/job3','owner','thread','telegram','chat','failed','run-3','not_dispatched',20,30,1,10,30,10,30,30)");
        const completion = fixture(contractFixtures(V0Contracts), 'CompletionEnvelopeV1Schema');
        const envelope = JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({ ...completion, envelopeId: 'env-1', commandId: 'c3', runId: 'run-3' }));
        db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, terminal_generation, envelope_json, state, created_at, updated_at) VALUES ('env-1','c3','run-3','terminal',1,?,'pending',30,30)").run(envelope);
        const mismatchedTerminalEnvelope = JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({ ...completion, envelopeId: 'env-mismatch', commandId: 'c3', runId: 'run-3', terminalGeneration: 2 }));
        assert.throws(() => db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, terminal_generation, envelope_json, state, created_at, updated_at) VALUES ('env-mismatch','c3','run-3','terminal',1,?,'pending',30,30)").run(mismatchedTerminalEnvelope), /constraint/i);
        assert.throws(() => db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, envelope_json, state, created_at, updated_at) VALUES ('env-null','c3','run-3','terminal',?,'pending',30,30)").run(JSON.stringify({ ...JSON.parse(envelope), envelopeId: 'env-null', terminalGeneration: null })), /constraint/i);
        db.exec("INSERT INTO career_deliveries (delivery_id, delivery_key, source_kind, envelope_id, source_command_id, source_run_id, destination_channel, destination_id, owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision, state, retry_deadline_at, created_at, updated_at) VALUES ('d2','key-2','completion','env-1','c3','run-3','telegram','chat','owner','thread','telegram','chat',0,'pending',100,30,30)");
        assert.throws(() => db.exec("INSERT INTO career_deliveries (delivery_id, delivery_key, source_kind, envelope_id, source_command_id, source_run_id, destination_channel, destination_id, owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision, state, retry_deadline_at, created_at, updated_at) VALUES ('d3','key-3','completion','env-1','c3','wrong-run','telegram','chat','owner','thread','telegram','chat',0,'pending',100,30,30)"), /constraint/i);

        db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, processing_started_at, suspension_generation, blocker_id, created_at, updated_at, queued_at) VALUES ('c4','a4','r4','job4','https://example.com/job4','owner','thread','telegram','chat','suspended','run-4','dispatched',20,1,'blocker-1',10,20,10)");
        assert.throws(() => db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, processing_started_at, processing_deadline_at, suspension_generation, blocker_id, created_at, updated_at, queued_at) VALUES ('bad-suspended-deadline','bad-a1','bad-r1','job','https://example.com/a','owner','thread','telegram','chat','suspended','run-bad-1','dispatched',20,30,1,'blocker-bad',10,20,10)"), /constraint/i);
        assert.throws(() => db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, claim_generation, lease_owner, lease_expires_at, heartbeat_at, processing_started_at, processing_deadline_at, blocker_id, created_at, updated_at, queued_at) VALUES ('bad-running-blocker','bad-a2','bad-r2','job','https://example.com/b','owner','thread','telegram','chat','running','run-bad-2','dispatched',1,'worker',40,20,20,30,'stray-blocker',10,20,10)"), /constraint/i);
        db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, claim_generation, lease_owner, lease_expires_at, heartbeat_at, processing_started_at, processing_deadline_at, created_at, updated_at, queued_at) VALUES ('good-running','good-a','good-r','job','https://example.com/good','owner','thread','telegram','chat','running','run-good','dispatched',1,'worker',40,20,20,30,10,20,10)");
        db.exec("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, claim_generation, lease_owner, lease_expires_at, heartbeat_at, processing_started_at, processing_deadline_at, suspension_generation, blocker_id, created_at, updated_at, queued_at) VALUES ('good-resuming','resume-a','resume-r','job','https://example.com/resume','owner','thread','telegram','chat','resuming','run-resume','dispatched',1,'worker',40,20,20,30,1,'resume-blocker',10,20,10)");
        db.prepare("INSERT INTO career_suspensions (suspension_id, command_id, run_id, suspended_step, blocker_kind, blocker_state, blocker_schema_version, generation, safe_payload, payload_hash, source_hash, profile_hash, prompt_version, prompt_hash, resume_schema_version, resume_schema_hash, allowed_response, issued_at, expires_at, created_at, updated_at) VALUES ('blocker-1','c4','run-4','acquire','reauth_required','pending',1,1,'{}',?,?,?,1,?,1,?,'{}',20,40,20,20)").run(hash, hash, hash, hash, hash);
        const suspensionCompletion = suspensionEnvelope(completion);
        const badSuspensionEnvelope = JSON.stringify(V0Contracts.CompletionEnvelopeV1Schema.parse({
          ...suspensionCompletion, envelopeId: 'env-bad', commandId: 'c4', runId: 'run-4',
          blocker: { ...suspensionCompletion.blocker, blockerId: 'other-blocker' },
        }));
        assert.throws(() => db.prepare("INSERT INTO career_completion_outbox (envelope_id, command_id, run_id, envelope_kind, suspension_generation, suspension_id, envelope_json, state, created_at, updated_at) VALUES ('env-bad','c4','run-4','suspension',1,'blocker-1',?,'pending',20,20)").run(badSuspensionEnvelope), /constraint/i);
        assert.throws(() => db.exec("INSERT INTO career_deliveries (delivery_id, delivery_key, source_kind, turn_delivery_id, destination_channel, destination_id, owner_resource_id, thread_id, origin_channel, origin_destination, authorization_revision, state, rendered_bytes, rendered_hash, attempt_count, first_attempt_at, retry_deadline_at, created_at, updated_at) VALUES ('d-unknown','key-unknown','turn','turn-unknown','telegram','chat','owner','thread','telegram','chat',0,'send_unknown',x'01','sha256:" + 'b'.repeat(64) + "',1,2,100,1,2)"), /constraint/i);
        assert.throws(() => db.exec("UPDATE career_suspensions SET blocker_state='accepted' WHERE suspension_id='blocker-1'"), /constraint/i);
        db.exec("INSERT INTO career_stage_journal (stage_record_id, command_id, run_id, stage_key, stage_version, state, idempotency_key, created_at, updated_at) VALUES ('stage-1','c4','run-4','acquire',1,'planned','stage-key',20,20)");
        assert.throws(() => db.exec("UPDATE career_stage_journal SET resolved_at=30, retention_deadline_at=40 WHERE stage_record_id='stage-1'"), /constraint/i);
        assert.throws(() => db.exec("INSERT INTO career_turn_inbox (event_key,event_kind,owner_resource_id,thread_id,safe_payload,created_at) VALUES ('bad-json','user','owner','thread','not-json',1)"), /constraint/i);
        assert.throws(() => db.exec("INSERT INTO career_structured_events (event_id,event_kind,safe_fields,occurred_at,retention_deadline_at) VALUES ('bad-json','audit','not-json',1,2)"), /constraint/i);
        db.exec("INSERT INTO career_turn_inbox (event_key,event_kind,owner_resource_id,thread_id,safe_payload,created_at) VALUES ('good-json','user','owner','thread','{}',1)");
        db.exec("INSERT INTO career_structured_events (event_id,event_kind,safe_fields,occurred_at,retention_deadline_at) VALUES ('good-json','audit','{}',1,2)");
        db.close();
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    id: 'P18-checksum-drift-blocks-readiness',
    run: () => {
      assert.equal(Object.isFrozen(MIGRATIONS), true);
      for (const migration of MIGRATIONS) {
        assert.equal(Object.isFrozen(migration), true);
        assert.equal(createHash('sha256').update(migration.sql).digest('hex'), migration.checksum);
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-drift-'));
      const databasePath = path.join(dir, 'operational.db');
      try {
        const store = new CareerStore(`file:${databasePath}`);
        store.close();
        const database = new DatabaseSync(databasePath);
        database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run('0'.repeat(64));
        database.close();
        assert.throws(() => new CareerStore(`file:${databasePath}`), /checksum drift/i);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P18-remote-operational-db-rejected',
    run: () => {
      for (const databaseUrl of ['libsql://career.turso.io', 'https://career.turso.io', 'file:./relative.db', ':memory:', 'file::memory:']) {
        assert.throws(() => resolveRuntimeConfig({ dataDir: '/tmp/career-v0-config', databaseUrl, env: {} }), /absolute local file/i);
        assert.throws(() => new CareerStore(databaseUrl), /absolute local file/i);
      }
    },
  },
  {
    id: 'P18-one-authoritative-file-db',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-shared-'));
      try {
        const config = resolveRuntimeConfig({ dataDir: dir, env: { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0', CAREER_COPILOT_INTAKE_HASH_KEY: 'k'.repeat(32) } });
        const applicationStore = new CareerStore(config.databaseUrl);
        const mastraStorage = new LibSQLStore({ id: 'shared-operational-storage', url: config.databaseUrl });
        await mastraStorage.init();
        applicationStore.close();
        await mastraStorage.close();

        const database = new DatabaseSync(path.join(dir, 'mastra.db'), { readOnly: true });
        const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name);
        assert.ok(tables.includes('schema_migrations'));
        assert.ok(tables.some((name) => name.startsWith('mastra_')));
        database.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P2-installed-duplicate-startAsync',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-start-'));
      const executionGate = Promise.withResolvers<void>();
      let executionCount = 0;
      let finishedCount = 0;
      let acceptedStartCount = 0;
      try {
        const step = createStep({
          id: 'count-starts',
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ value: z.string(), starts: z.number() }),
          execute: async ({ inputData }) => {
            const starts = ++executionCount;
            await executionGate.promise;
            finishedCount += 1;
            return { value: inputData.value, starts };
          },
        });
        const workflow = createWorkflow({
          id: 'v0-duplicate-start-async',
          inputSchema: z.object({ value: z.string() }),
          outputSchema: z.object({ value: z.string(), starts: z.number() }),
        })
          .then(step)
          .commit();
        const mastra = new Mastra({
          workflows: { workflow },
          storage: new LibSQLStore({ id: 'v0-start-storage', url: `file:${path.join(dir, 'mastra.db')}` }),
        });
        const registered = mastra.getWorkflow('workflow');
        const runId = 'cc-save-v1:test-command:1';
        const run = await registered.createRun({ runId, resourceId: 'owner-1' });

        assert.equal(run.runId, runId);
        const starts = await Promise.allSettled([
          run.startAsync({ inputData: { value: 'payload' } }),
          run.startAsync({ inputData: { value: 'payload' } }),
        ]);
        acceptedStartCount = starts.filter(({ status }) => status === 'fulfilled').length;
        assert.deepEqual(starts, [
          { status: 'fulfilled', value: { runId } },
          { status: 'fulfilled', value: { runId } },
        ]);
        await waitFor(() => executionCount >= 2, 'duplicate workflow executions did not both start');
        assert.equal(executionCount, 2);

        executionGate.resolve();
        await waitFor(() => finishedCount === 2, 'duplicate workflow executions did not both finish');
        const stored = await waitForWorkflowRun(registered, runId);
        assert.equal(executionCount, 2);
        assert.equal(stored.status, 'success');
        assert.equal(stored.result?.value, 'payload');
        assert.ok(stored.result?.starts === 1 || stored.result?.starts === 2);
      } finally {
        executionGate.resolve();
        await waitFor(
          () => finishedCount >= acceptedStartCount,
          `only ${finishedCount} of ${acceptedStartCount} accepted workflow executions finished during cleanup`,
        );
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P8-installed-message-history-incomplete-tool-call',
    run: async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-memory-'));
      try {
        const memory = new Memory({
          storage: new LibSQLStore({ id: 'v0-memory-storage', url: `file:${path.join(dir, 'memory.db')}` }),
          options: primaryMemoryConfig,
        });
        const now = new Date();
        await memory.saveThread({
          thread: { id: 'thread-1', resourceId: 'owner-1', title: 'V0', metadata: {}, createdAt: now, updatedAt: now },
          memoryConfig: primaryMemoryConfig,
        });
        await memory.saveMessages({
          memoryConfig: primaryMemoryConfig,
          messages: [
            dbMessage('user-complete', 'user', [{ type: 'text', text: 'use the completed tool result' }]),
            dbMessage('assistant-complete-result', 'assistant', [toolInvocation('result', 'complete-call', 'ok')]),
            dbMessage('assistant-incomplete-call', 'assistant', [toolInvocation('call', 'incomplete-call')]),
            dbMessage('user-trailing', 'user', [{ type: 'text', text: 'keep this trailing user request' }]),
          ],
        });

        const recalled = await memory.recall({
          threadId: 'thread-1',
          threadConfig: primaryMemoryConfig,
        });
        assert.match(JSON.stringify(recalled.messages), /incomplete-call/);

        const messageList = new MessageList({ threadId: 'thread-1', resourceId: 'owner-1' });
        messageList.add(recalled.messages, 'memory');
        const modelPrompt = await messageList.get.all.aiV5.llmPrompt();
        const promptText = JSON.stringify(modelPrompt);
        const userTexts = modelPrompt
          .filter(({ role }) => role === 'user')
          .flatMap(({ content }) => (Array.isArray(content) ? content : []))
          .filter(({ type }) => type === 'text')
          .map(({ text }) => text);
        const completedToolCall = modelPrompt
          .filter(({ role }) => role === 'assistant')
          .flatMap(({ content }) => (Array.isArray(content) ? content : []))
          .find(({ type }) => type === 'tool-call');
        const completedToolResult = modelPrompt
          .filter(({ role }) => role === 'tool')
          .flatMap(({ content }) => (Array.isArray(content) ? content : []))
          .find(({ type }) => type === 'tool-result');

        assert.ok(userTexts.includes('use the completed tool result'));
        assert.ok(userTexts.includes('keep this trailing user request'));
        assert.ok(completedToolCall);
        assert.deepEqual(
          {
            type: completedToolCall.type,
            toolCallId: completedToolCall.toolCallId,
            toolName: completedToolCall.toolName,
            input: completedToolCall.input,
          },
          { type: 'tool-call', toolCallId: 'complete-call', toolName: 'fixtureLookup', input: {} },
        );
        assert.ok(completedToolResult);
        assert.deepEqual(
          {
            type: completedToolResult.type,
            toolCallId: completedToolResult.toolCallId,
            toolName: completedToolResult.toolName,
            input: completedToolResult.input,
            output: completedToolResult.output,
          },
          {
            type: 'tool-result',
            toolCallId: 'complete-call',
            toolName: 'fixtureLookup',
            input: {},
            output: { type: 'text', value: 'ok' },
          },
        );
        assert.doesNotMatch(promptText, /incomplete-call/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'P7-installed-agent-browser-tool-inventory',
    run: () => {
      const browser = new AgentBrowser();
      assert.deepEqual(Object.keys(browser.getTools()).sort(), browserToolIds);
    },
  },
  {
    id: 'P18-schema-roundtrip',
    run: async () => {
      const contracts = await loadV0Contracts();
      const fixtures = contractFixtures(contracts);
      for (const [schemaName, schema, payload] of fixtures) assert.deepEqual(schema.parse(payload), payload, schemaName);

      const inbound = fixture(fixtures, 'InboundEventV1Schema');
      const untrusted = omit(inbound, ['identityAuthority', 'resourceId', 'threadId']);
      const normalized = contracts.normalizeInboundEventV1(untrusted, { resourceId: 'server-owner', threadId: 'server-thread' });
      assert.deepEqual(normalized, { ...untrusted, identityAuthority: 'server', resourceId: 'server-owner', threadId: 'server-thread' });
      assert.equal(contracts.UntrustedInboundEventV1Schema.safeParse({ ...untrusted, resourceId: 'forged-owner' }).success, false);
      assert.equal(contracts.UntrustedInboundEventV1Schema.safeParse({ ...untrusted, identityAuthority: 'server' }).success, false);

      const command = fixture(fixtures, 'CommandV1Schema');
      for (const state of ['queued', 'starting', 'running', 'retry_wait', 'suspended', 'resuming', 'succeeded', 'failed', 'timed_out'] as const) {
        assert.equal(contracts.CommandV1Schema.safeParse(commandForState(command, state)).success, true, `queue ${state}`);
      }
      for (const dispatchState of ['not_dispatched', 'dispatching', 'dispatched', 'start_unknown'] as const) {
        assert.equal(contracts.CommandV1Schema.safeParse(commandWithDispatch(command, 'starting', dispatchState)).success, true, `starting + ${dispatchState}`);
      }
      for (const state of ['failed', 'timed_out'] as const) {
        for (const dispatchState of ['not_dispatched', 'dispatching', 'dispatched', 'start_unknown'] as const) {
          assert.equal(contracts.CommandV1Schema.safeParse(commandWithDispatch(command, state, dispatchState)).success, true, `${state} + ${dispatchState}`);
        }
      }
      assert.equal(contracts.CommandV1Schema.safeParse(suspensionExpiryTimedOut(command)).success, true, 'suspension-expiry timeout');
      const retryResume = commandForState(command, 'resuming');
      retryResume.progress = { ...retryResume.progress, suspensionGeneration: 0, blockerId: null };
      assert.equal(contracts.CommandV1Schema.safeParse(retryResume).success, true, 'first retry resume');
      assert.equal(contracts.CommandV1Schema.safeParse({
        ...retryResume,
        progress: { ...retryResume.progress, suspensionGeneration: 1, blockerId: null },
      }).success, true, 'retry resume after a historical suspension');
      const suspensionResume = commandForState(command, 'resuming');
      assert.equal(contracts.CommandV1Schema.safeParse(suspensionResume).success, true, 'accepted suspension resume');
      assert.equal(contracts.CommandV1Schema.safeParse({
        ...retryResume,
        progress: { ...retryResume.progress, suspensionGeneration: 0, blockerId: 'blocker-1' },
      }).success, false, 'suspension resume requires a positive generation');
      const completion = fixture(fixtures, 'CompletionEnvelopeV1Schema');
      assert.equal(contracts.CompletionEnvelopeV1Schema.safeParse(previouslySeenEnvelope(completion)).success, true, 'previously_seen');
      assert.equal(contracts.CompletionEnvelopeV1Schema.safeParse(failureEnvelope(completion, 'failed')).success, true, 'failed without tracker row');
      assert.equal(contracts.CompletionEnvelopeV1Schema.safeParse(failureEnvelope(completion, 'timed_out')).success, true, 'timed_out without tracker row');
      assert.equal(contracts.CompletionEnvelopeV1Schema.safeParse(suspensionEnvelope(completion)).success, true);
      assert.equal(contracts.CommandV1Schema.safeParse({ ...command, arguments: { canonicalUrl: 'https://example.com/job?id=1' } }).success, true);
      assert.equal(contracts.CompletionEnvelopeV1Schema.safeParse({ ...completion, safeInput: { ...completion.safeInput, originalUrl: 'https://EXAMPLE.com/job?id=raw' } }).success, true, 'distinct safe original URL');
      assert.equal(contracts.InboundEventV1Schema.safeParse({ ...inbound, processingResult: { status: 'rejected', reason: 'unauthorized', safeMessage: 'Not authorized.' } }).success, true);
      const stage = fixture(fixtures, 'StageRecordV1Schema');
      const stageOutcomes = [
        ['planned', 'not_started'], ['applying', 'not_started'], ['applied', 'effect_verified'],
        ['outcome_unknown', 'outcome_unknown'], ['reconciled', 'effect_verified'], ['reconciled', 'effect_absent'],
        ['authorization_blocked', 'authorization_blocked'], ['compensated', 'compensated'],
      ] as const;
      for (const [state, safeOutcome] of stageOutcomes) {
        assert.equal(contracts.StageRecordV1Schema.safeParse({ ...stage, state, safeOutcome }).success, true, `stage ${state} + ${safeOutcome}`);
      }
      const blocker = fixture(fixtures, 'BlockerEnvelopeV1Schema');
      for (const state of ['pending', 'accepted', 'applying', 'applied', 'invalidated', 'expired'] as const) {
        assert.equal(contracts.BlockerEnvelopeV1Schema.safeParse(blockerForState(blocker, state, inbound.payloadHash)).success, true, `blocker ${state}`);
      }
      assert.equal(contracts.BlockerEnvelopeV1Schema.safeParse({ ...acceptedBlocker(blocker, inbound.payloadHash), allowedResponse: { kind: 'text', minimumLength: 2, maximumLength: 4 }, resumePayload: { schemaVersion: 1, kind: 'text', value: 'okay' } }).success, true);
      const health = fixture(fixtures, 'HealthSnapshotV1Schema');
      for (const [status, ready, degraded] of [['starting', false, false], ['ready', true, false], ['degraded', true, true], ['not_ready', false, false]] as const) {
        assert.equal(contracts.HealthSnapshotV1Schema.safeParse({ ...health, status, ready, degraded }).success, true, `health ${status}`);
      }
      const delivery = fixture(fixtures, 'DeliveryRecordV1Schema');
      assert.equal(contracts.DeliveryRecordV1Schema.safeParse({ ...delivery, source: { kind: 'turn', turnDeliveryId: 'turn-delivery-1' } }).success, true);
      for (const state of ['pending', 'claimed', 'rendered', 'sending', 'delivered', 'retry_wait', 'blocked', 'send_unknown', 'dead_letter']) {
        assert.equal(contracts.DeliveryRecordV1Schema.safeParse(deliveryForState(delivery, state)).success, true, `delivery ${state}`);
      }
    },
  },
  {
    id: 'P18-reject-unknown-version',
    run: async () => {
      const contracts = await loadV0Contracts();
      const fixtures = contractFixtures(contracts);
      const hash = `sha256:${'a'.repeat(64)}`;
      for (const [schemaName, schema, payload] of fixtures) {
        reject(schema, { ...payload, schemaVersion: 2 }, `${schemaName}: future version`);
        reject(schema, { ...payload, unexpected: true }, `${schemaName}: unknown top-level key`);
      }

      const inbound = fixture(fixtures, 'InboundEventV1Schema');
      const command = fixture(fixtures, 'CommandV1Schema');
      const stage = fixture(fixtures, 'StageRecordV1Schema');
      const blocker = fixture(fixtures, 'BlockerEnvelopeV1Schema');
      const evidence = fixture(fixtures, 'EvidenceRecordV1Schema');
      const artifact = fixture(fixtures, 'ArtifactManifestV1Schema');
      const completion = fixture(fixtures, 'CompletionEnvelopeV1Schema');
      const turn = fixture(fixtures, 'TurnDeliveryV1Schema');
      const delivery = fixture(fixtures, 'DeliveryRecordV1Schema');
      const health = fixture(fixtures, 'HealthSnapshotV1Schema');

      const requiredFieldCases: [any, any, string][] = [
        [contracts.InboundEventV1Schema, omit(inbound, ['processingResult']), 'inbound processing result'],
        [contracts.CommandV1Schema, omit(command, ['attemptId']), 'command attempt ID'],
        [contracts.CommandV1Schema, omit(command, ['canonicalJobKey']), 'command canonical job key'],
        [contracts.CommandV1Schema, omit(command, ['terminalGeneration']), 'command terminal generation'],
        [contracts.EvidenceRecordV1Schema, omit(evidence, ['retentionDeadline']), 'evidence retention deadline'],
        [contracts.ArtifactManifestV1Schema, omit(artifact, ['citedExcerpts']), 'retained cited excerpts'],
      ];
      for (const [schema, payload, label] of requiredFieldCases) reject(schema, payload, label);

      const accepted = acceptedBlocker(blocker, hash);
      const nestedUnknownCases: [any, any, string][] = [
        [contracts.InboundEventV1Schema, { ...inbound, origin: { ...inbound.origin, forged: true } }, 'inbound origin'],
        [contracts.CommandV1Schema, { ...command, claim: { ...command.claim, forged: true } }, 'command claim'],
        [contracts.BlockerEnvelopeV1Schema, { ...accepted, resumePayload: { ...accepted.resumePayload, forged: true } }, 'resume payload'],
        [contracts.ArtifactManifestV1Schema, { ...artifact, citedExcerpts: [{ ...artifact.citedExcerpts[0], forged: true }] }, 'cited excerpt'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, providerEvidence: { ...delivery.providerEvidence, forged: true } }, 'provider evidence'],
        [contracts.HealthSnapshotV1Schema, { ...health, queue: { ...health.queue, forged: true } }, 'health queue'],
      ];
      for (const [schema, payload, label] of nestedUnknownCases) reject(schema, payload, `unknown nested key: ${label}`);
      reject(contracts.BlockerEnvelopeV1Schema, { ...accepted, resumePayload: { ...accepted.resumePayload, schemaVersion: 2 } }, 'future resume payload version');
      reject(contracts.BlockerEnvelopeV1Schema, { ...blocker, resumeSchemaVersion: 2 }, 'pending blocker future resume schema version');

      for (const dispatchState of ['dispatching', 'dispatched', 'start_unknown'] as const) {
        reject(contracts.CommandV1Schema, { ...commandForState(command, 'queued'), workflow: { ...commandForState(command, 'queued').workflow, startDispatchState: dispatchState } }, `queued + ${dispatchState}`);
      }
      for (const state of ['running', 'retry_wait', 'suspended', 'resuming', 'succeeded'] as const) {
        for (const dispatchState of ['not_dispatched', 'dispatching', 'start_unknown'] as const) {
          reject(contracts.CommandV1Schema, { ...commandForState(command, state), workflow: { ...commandForState(command, state).workflow, startDispatchState: dispatchState } }, `${state} + ${dispatchState}`);
        }
      }

      const commandCases: [any, string][] = [
        [{ ...commandForState(command, 'starting'), workflow: { ...command.workflow, runId: null } }, 'starting without run ID'],
        [{ ...commandForState(command, 'starting'), workflow: { ...command.workflow, runId: 'wrong-run' } }, 'starting with nondeterministic run ID'],
        [{ ...commandForState(command, 'queued'), retry: { ...command.retry, processingStartedAt: inbound.receivedAt } }, 'queued processing timestamp'],
        [{ ...commandForState(command, 'queued'), workflow: { ...command.workflow, runId: null, startDispatchState: 'dispatching' } }, 'queued dispatch evidence'],
        [{ ...commandForState(command, 'queued'), claim: command.claim }, 'queued active claim'],
        [{ ...command, claim: { ...command.claim, heartbeatAt: null } }, 'partial claim'],
        [{ ...command, retry: { ...command.retry, processingDeadlineAt: null } }, 'active without deadline'],
        [{ ...commandForState(command, 'timed_out'), retry: { ...command.retry, processingDeadlineAt: null } }, 'unexplained timeout without deadline'],
        [{ ...commandForState(command, 'retry_wait'), retry: { ...command.retry, nextAttemptAt: null } }, 'retry wait without due time'],
        [{ ...commandForState(command, 'suspended'), progress: { ...command.progress, blockerId: null } }, 'suspended without blocker'],
        [{ ...commandForState(command, 'succeeded'), terminalGeneration: 0 }, 'terminal without generation'],
        [{ ...command, terminalGeneration: 1 }, 'nonterminal terminal generation'],
        [{ ...command, claim: { ...command.claim, generation: 0 } }, 'active claim with zero generation'],
        [{ ...command, workflow: { ...command.workflow, startDispatchState: 'dispatching' } }, 'running without dispatched evidence'],
        [{ ...commandForState(command, 'retry_wait'), workflow: { ...command.workflow, startDispatchState: 'start_unknown' } }, 'retry wait without dispatched evidence'],
        [commandWithDispatch(command, 'failed', 'start_unknown', false), 'start-unknown failure without reconciliation error'],
        [commandWithDispatch(command, 'timed_out', 'start_unknown', false), 'start-unknown timeout without reconciliation error'],
        [{ ...command, workflow: { ...command.workflow, resourceId: 'other-owner' } }, 'workflow resource identity mismatch'],
      ];
      for (const state of ['suspended', 'succeeded', 'failed', 'timed_out'] as const) reject(contracts.CommandV1Schema, { ...commandForState(command, state), claim: command.claim }, `${state} retained active claim`);
      for (const [payload, label] of commandCases) reject(contracts.CommandV1Schema, payload, label);

      const completionCases: [any, string][] = [
        [{ ...suspensionEnvelope(completion), queueState: 'running' }, 'suspension queue state'],
        [{ ...suspensionEnvelope(completion), outcome: 'failed' }, 'suspension outcome'],
        [{ ...suspensionEnvelope(completion), blocker: null }, 'suspension blocker'],
        [{ ...completion, queueState: 'failed', outcome: 'succeeded' }, 'terminal state/outcome mismatch'],
        [{ ...completion, blocker: { blockerId: 'b', kind: 'x', requiredAction: 'act', expiresAt: completion.createdAt } }, 'terminal blocker'],
        [{ ...completion, suspensionGeneration: 1 }, 'terminal suspension generation'],
        [{ ...completion, queueState: 'failed', outcome: 'previously_seen' }, 'duplicate outcome on failure'],
        [{ ...completion, outcome: 'previously_seen', handoff: { ...completion.handoff, details: { ...completion.handoff.details, kind: 'success' } } }, 'duplicate detail mismatch'],
        [{ ...failureEnvelope(completion, 'failed'), handoff: { ...failureEnvelope(completion, 'failed').handoff, details: { ...failureEnvelope(completion, 'failed').handoff.details, kind: 'timeout' } } }, 'failure detail mismatch'],
        [{ ...completion, handoff: { ...completion.handoff, finalTrackerStatus: null } }, 'succeeded missing final tracker status'],
        [{ ...previouslySeenEnvelope(completion), handoff: { ...previouslySeenEnvelope(completion).handoff, finalTrackerStatus: null } }, 'previously_seen missing final tracker status'],
      ];
      for (const [payload, label] of completionCases) reject(contracts.CompletionEnvelopeV1Schema, payload, label);

      const semanticCases: [any, any, string][] = [
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, allowedResponse: { kind: 'text', minimumLength: 10, maximumLength: 2 } }, 'allowed text bounds'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, expiresAt: blocker.issuedAt }, 'blocker expiry ordering'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, state: 'accepted' }, 'accepted blocker payload evidence'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, state: 'invalidated', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'confirmation', value: 'ready' }, resumePayloadHash: hash }, 'invalidated blocker retained acceptance'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, state: 'accepted', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'text', value: 'ready' }, resumePayloadHash: hash }, 'resume kind mismatch'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, state: 'accepted', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'confirmation', value: 'later' }, resumePayloadHash: hash }, 'confirmation outside allowed choices'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, allowedResponse: { kind: 'text', minimumLength: 2, maximumLength: 4 }, state: 'accepted', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'text', value: 'x' }, resumePayloadHash: hash }, 'resume text outside configured bounds'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, state: 'accepted', acceptedAt: blocker.expiresAt, resumePayload: { schemaVersion: 1, kind: 'confirmation', value: 'ready' }, resumePayloadHash: hash }, 'acceptance after expiry'],
        [contracts.BlockerEnvelopeV1Schema, { ...blocker, resumeSchemaVersion: 2, state: 'accepted', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'confirmation', value: 'ready' }, resumePayloadHash: hash }, 'resume schema binding mismatch'],
        [contracts.EvidenceRecordV1Schema, { ...evidence, excerpts: [{ ...evidence.excerpts[0], start: 33, end: 33 }] }, 'empty evidence span'],
        [contracts.ArtifactManifestV1Schema, { ...artifact, citedExcerpts: [{ ...artifact.citedExcerpts[0], evidenceId: 'unbound-evidence' }] }, 'citation evidence binding'],
        [contracts.EvidenceRecordV1Schema, { ...evidence, excerpts: [{ ...evidence.excerpts[0], end: 121 }] }, 'evidence span outside extraction'],
        [contracts.StageRecordV1Schema, { ...stage, safeOutcome: 'outcome_unknown' }, 'stage state/outcome mismatch'],
        [contracts.HealthSnapshotV1Schema, { ...health, ready: false }, 'health ready mismatch'],
        [contracts.HealthSnapshotV1Schema, { ...health, status: 'degraded', degraded: false }, 'health degraded mismatch'],
        [contracts.TurnDeliveryV1Schema, { ...turn, renderedResponse: 'x'.repeat(8_001) }, 'turn rendered byte bound'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, renderedResponse: null }, 'delivered without rendering'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, providerEvidence: null }, 'delivered without provider evidence'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, providerEvidence: { ...delivery.providerEvidence, outcome: 'unknown' } }, 'delivered with unknown evidence'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'claimed'), claimGeneration: 0 }, 'claimed with zero generation'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'claimed'), claimOwner: null }, 'claimed with partial claim'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, claimOwner: 'dispatcher-1', claimExpiresAt: delivery.updatedAt, heartbeatAt: delivery.createdAt }, 'delivered retained claim'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'sending'), renderedResponse: null, responseHash: null }, 'sending without immutable rendering'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'send_unknown'), providerEvidence: { ...delivery.providerEvidence, outcome: 'acknowledged' } }, 'send unknown evidence mismatch'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'dead_letter'), providerEvidence: { ...delivery.providerEvidence, outcome: 'acknowledged' } }, 'dead letter evidence mismatch'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'rendered'), firstAttemptAt: delivery.createdAt }, 'zero attempts with first attempt timestamp'],
        [contracts.DeliveryRecordV1Schema, { ...deliveryForState(delivery, 'rendered'), attemptCount: 1 }, 'positive attempts without first attempt timestamp'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, authorizationRevision: -1 }, 'negative authorization revision'],
        [contracts.DeliveryRecordV1Schema, { ...delivery, source: { kind: 'turn', transportEventId: 'event-1', turnId: 'turn-1' } }, 'legacy mutable turn source'],
      ];
      for (const [schema, payload, label] of semanticCases) reject(schema, payload, label);

      for (const receivedAt of ['2026-08-03T12:00:00Z', '2026-08-03T12:00:00.00Z', '2026-08-03T12:00:00.0000Z', '2026-08-03T12:00:00.000+00:00']) {
        reject(contracts.InboundEventV1Schema, { ...inbound, receivedAt }, `timestamp ${receivedAt}`);
      }
      for (const canonicalUrl of [
        'http://example.com/job', 'file:///tmp/job', 'javascript:alert(1)', 'https://user:pass@example.com/job',
        'https://example.com/job#fragment', 'https://example.com:8443/job', 'https://EXAMPLE.com/job',
        'https://example.com:443/job', 'https://example.com/a/../job',
      ]) {
        reject(contracts.CommandV1Schema, { ...command, arguments: { canonicalUrl } }, `URL ${canonicalUrl}`);
      }

      reject(contracts.ResumePayloadV1Schema, { schemaVersion: 2, kind: 'text', value: 'ok' }, 'standalone resume future version');
      reject(contracts.ArtifactManifestV1Schema, { ...artifact, citedExcerpts: [{ evidenceId: 'evidence-1', start: 0, end: 2, text: 'ok', hash: 'bad' }] }, 'citation hash');
      reject(contracts.BlockerEnvelopeV1Schema, omit(blocker, ['promptHash']), 'blocker prompt binding');
      reject(contracts.BlockerEnvelopeV1Schema, omit(blocker, ['resumeSchemaVersion']), 'blocker schema version binding');
      assert.equal(hash.length, 71);
    },
  },
  {
    id: 'P1-legal-queue-transition-table',
    run: () => {
      const expected = {
        queued: ['starting'],
        starting: ['running', 'timed_out'],
        running: ['retry_wait', 'suspended', 'succeeded', 'failed', 'timed_out'],
        retry_wait: ['resuming', 'timed_out'],
        suspended: ['resuming', 'timed_out'],
        resuming: ['running', 'timed_out'],
        succeeded: [],
        failed: [],
        timed_out: [],
      };
      assert.deepEqual(V0Contracts.LEGAL_QUEUE_TRANSITIONS_V0, expected);
      const states = Object.keys(expected) as V0Contracts.QueueStateV0[];
      for (const from of states) {
        for (const to of states) {
          const listed = expected[from].includes(to as never);
          assert.equal(V0Contracts.isLegalQueueTransitionV0(from, to), listed, `${from} -> ${to}`);
        }
      }
      withQueueStore(({ databasePath }) => {
        const database = new DatabaseSync(databasePath);
        database.exec('PRAGMA ignore_check_constraints = ON');
        for (const from of states) {
          for (const to of states) {
            if (from === to) continue;
            const id = `trigger-${from}-${to}`;
            database.prepare("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, created_at, updated_at, queued_at) VALUES (?, ?, ?, 'job', 'https://example.com/job', 'owner-1', 'thread-1', 'telegram', 'chat-1', ?, 1, 1, 1)").run(id, `${id}:attempt`, `${id}:request`, from);
            const update = () => database.prepare('UPDATE career_commands SET queue_state = ? WHERE command_id = ?').run(to, id);
            if (expected[from].includes(to as never)) assert.doesNotThrow(update, `${from} -> ${to}`);
            else assert.throws(update, /illegal queue transition|terminal command is immutable/i, `${from} -/-> ${to}`);
          }
        }
        database.close();
      });
    },
  },
  {
    id: 'P1-queued-has-no-processing-deadline',
    run: () => withQueueStore(({ store }) => {
      const first = store.enqueueCommand(queueInput('queued-a'));
      const second = store.enqueueCommand(queueInput('queued-b'));
      assert.deepEqual({ position: first.position, state: first.state }, { position: 1, state: 'queued' });
      assert.deepEqual({ position: second.position, state: second.state }, { position: 2, state: 'queued' });
      assert.equal(store.getCommand('queued-a')?.processingDeadlineAt, null);
      assert.equal(store.queuePosition('queued-b'), 2);
    }),
  },
  {
    id: 'P1-database-clock-lease',
    run: () => withQueueStore(({ store, databasePath }) => {
      store.enqueueCommand(queueInput('clock-command'));
      const originalNow = Date.now;
      Date.now = () => 1;
      let claim;
      try { claim = store.claimNextRunnable('worker-clock'); } finally { Date.now = originalNow; }
      assert.ok(claim);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const databaseNow = Number((database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get() as { now: number }).now);
      database.close();
      assert.ok(Math.abs(claim.heartbeatAt - databaseNow) < 2_000);
      assert.equal(claim.leaseExpiresAt - claim.heartbeatAt, 120_000);
    }),
  },
  {
    id: 'P1-simultaneous-process-claim',
    run: async () => withQueueStore(async ({ store, databasePath }) => {
      store.enqueueCommand(queueInput('simultaneous-command'));
      const dir = path.dirname(databasePath);
      const gate = path.join(dir, 'claim-go');
      const moduleUrl = new URL('../src/storage/career-store.ts', import.meta.url).href;
      const children = ['a', 'b'].map((worker) => {
        const ready = path.join(dir, `claim-${worker}-ready`);
        const output = path.join(dir, `claim-${worker}.json`);
        const program = `
          import fs from 'node:fs';
          import { setTimeout as delay } from 'node:timers/promises';
          import { CareerStore } from ${JSON.stringify(moduleUrl)};
          fs.writeFileSync(${JSON.stringify(ready)}, '');
          while (!fs.existsSync(${JSON.stringify(gate)})) await delay(2);
          const store = new CareerStore(${JSON.stringify(`file:${databasePath}`)});
          const claim = store.claimNextRunnable(${JSON.stringify(`worker-${worker}`)});
          fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(claim));
          store.close();
        `;
        return { ready, output, result: runNode(program) };
      });
      await waitFor(() => children.every(({ ready }) => fs.existsSync(ready)), 'claim processes did not become ready');
      fs.writeFileSync(gate, '');
      await Promise.all(children.map(({ result }) => result));
      const claims = children.map(({ output }) => JSON.parse(fs.readFileSync(output, 'utf8'))).filter(Boolean);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].claimGeneration, 1);
      assert.equal(claims[0].ownerResourceId, 'owner-1');
      const persisted = store.getCommand('simultaneous-command')!;
      assert.equal(persisted.claimGeneration, 1);
      assert.equal(persisted.leaseOwner, claims[0].leaseOwner);
    }),
  },
  {
    id: 'P1-atomic-claim-owner-predicate',
    run: () => withQueueStore(({ store, databasePath }) => {
      store.enqueueCommand(queueInput('owner-predicate'));
      const prepare = DatabaseSync.prototype.prepare;
      let intercepted = false;
      DatabaseSync.prototype.prepare = function (sql: string) {
        const statement = prepare.call(this, sql);
        if (!intercepted && /UPDATE career_commands[\s\S]*queue_state = 'starting'/.test(sql)) {
          intercepted = true;
          assert.match(sql, /owner_resource_id = \?/);
          return { run: (...args: unknown[]) => statement.run(...args.slice(0, -1), 'mismatched-owner') } as never;
        }
        return statement;
      };
      try {
        assert.throws(() => store.claimNextRunnable('worker-a'), /atomic queue claim lost unexpectedly/i);
      } finally {
        DatabaseSync.prototype.prepare = prepare;
      }
      assert.equal(intercepted, true);
      assert.equal(store.getCommand('owner-predicate')?.queueState, 'queued');

      const source = CareerStore.prototype.claimNextRunnable.toString();
      const updates = source.match(/UPDATE career_commands[\s\S]*?`/g) ?? [];
      assert.equal(updates.length, 3);
      for (const update of updates) assert.match(update, /owner_resource_id = \?/);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(database.prepare("SELECT owner_resource_id FROM career_commands WHERE command_id='owner-predicate'").get()!.owner_resource_id, 'owner-1');
      database.close();
    }),
  },
  {
    id: 'P1-stale-generation-zero-row',
    run: () => withQueueStore(({ store, databasePath }) => {
      store.enqueueCommand(queueInput('stale-command'));
      const claim = store.claimNextRunnable('worker-a')!;
      const starting = { ...claim, sourceState: 'starting' as const };
      for (const stale of [
        { ...starting, ownerResourceId: 'owner-2' },
        { ...starting, leaseOwner: 'worker-b' },
        { ...starting, claimGeneration: claim.claimGeneration + 1 },
        { ...starting, runId: 'wrong-run' },
      ]) assert.deepEqual(store.renewClaim(stale), { applied: false, reason: 'lease_lost' });
      const database = new DatabaseSync(databasePath);
      database.prepare('UPDATE career_commands SET lease_expires_at = ? WHERE command_id = ?').run(0, claim.commandId);
      database.close();
      assert.deepEqual(store.renewClaim(starting), { applied: false, reason: 'lease_lost' });
      assert.equal(store.getCommand('stale-command')?.claimGeneration, claim.claimGeneration);
    }),
  },
  {
    id: 'P1-reclaimed-worker-wins',
    run: async () => withQueueStore(async ({ store, databasePath }) => {
      store.enqueueCommand(queueInput('reclaimed-command'));
      const first = store.claimNextRunnable('worker-a')!;
      assert.equal(dispatchAndMarkRunning(store, databasePath, first).applied, true);
      await delay(25);
      const second = store.claimNextRunnable('worker-b')!;
      assert.equal(second.queueState, 'running');
      assert.equal(second.commandId, first.commandId);
      assert.equal(second.claimGeneration, first.claimGeneration + 1);
      assert.deepEqual(store.completeClaim({ ...first, sourceState: 'running' }, 'succeeded'), { applied: false, reason: 'lease_lost' });
      assert.equal(store.completeClaim({ ...second, sourceState: 'running' }, 'succeeded').applied, true);
    }, { leaseMs: 10 }),
  },
  {
    id: 'P1-terminal-immutable',
    run: () => withQueueStore(({ store, databasePath }) => {
      store.enqueueCommand(queueInput('terminal-command'));
      const claim = store.claimNextRunnable('worker-a')!;
      assert.equal(dispatchAndMarkRunning(store, databasePath, claim).applied, true);
      assert.equal(store.completeClaim({ ...claim, sourceState: 'running' }, 'succeeded').applied, true);
      assert.deepEqual(store.completeClaim({ ...claim, sourceState: 'running' }, 'failed'), { applied: false, reason: 'lease_lost' });
      const database = new DatabaseSync(databasePath);
      assert.throws(() => database.exec("UPDATE career_commands SET queue_state='queued' WHERE command_id='terminal-command'"), /terminal command is immutable/i);
      database.close();
    }),
  },
  {
    id: 'P3-stage-journal-required-for-effect',
    run: () => withQueueStore(({ store, databasePath }) => {
      store.enqueueCommand(queueInput('effect-command'));
      const claim = store.claimNextRunnable('worker-a')!;
      assert.equal(dispatchAndMarkRunning(store, databasePath, claim).applied, true);
      const guard = { ...claim, sourceState: 'running' as const, stageKey: 'sheet_commit', stageVersion: 1, idempotencyKey: 'effect-command:sheet_commit:1', expectedSheetFingerprint: `sha256:${'a'.repeat(64)}`, expectedRowVersion: 2 };
      assert.deepEqual(store.authorizeExternalEffect(guard), { authorized: false, reason: 'stage_guard_failed' });
      const database = new DatabaseSync(databasePath);
      database.prepare("INSERT INTO career_stage_journal (stage_record_id, command_id, run_id, stage_key, stage_version, state, idempotency_key, expected_sheet_fingerprint, expected_row_version, created_at, updated_at) VALUES ('effect-stage','effect-command',?,'sheet_commit',1,'planned',?,?,2,1,1)").run(claim.runId, guard.idempotencyKey, guard.expectedSheetFingerprint);
      database.exec("UPDATE career_stage_journal SET state='applying', updated_at=2 WHERE stage_record_id='effect-stage'");
      database.close();
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, stageVersion: 2 }), { authorized: false, reason: 'stage_guard_failed' });
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, idempotencyKey: 'wrong-key' }), { authorized: false, reason: 'stage_guard_failed' });
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, expectedRowVersion: 3 }), { authorized: false, reason: 'stage_guard_failed' });
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, ownerResourceId: 'owner-2' }), { authorized: false, reason: 'lease_lost' });
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, leaseOwner: 'worker-b' }), { authorized: false, reason: 'lease_lost' });
      assert.deepEqual(store.authorizeExternalEffect({ ...guard, claimGeneration: guard.claimGeneration + 1 }), { authorized: false, reason: 'lease_lost' });
      assert.deepEqual(store.authorizeExternalEffect(guard), { authorized: true, stageRecordId: 'effect-stage' });
      const expired = new DatabaseSync(databasePath);
      expired.prepare('UPDATE career_commands SET processing_deadline_at = 0 WHERE command_id = ?').run(claim.commandId);
      expired.close();
      assert.deepEqual(store.authorizeExternalEffect(guard), { authorized: false, reason: 'lease_lost' });
    }),
  },
  {
    id: 'P1-owner-and-deadline-fence-every-worker-write',
    run: () => withQueueStore(({ store, databasePath }) => {
      const expireDeadline = (commandId: string) => {
        const database = new DatabaseSync(databasePath);
        database.prepare('UPDATE career_commands SET processing_deadline_at = 0 WHERE command_id = ?').run(commandId);
        database.close();
      };
      store.enqueueCommand(queueInput('deadline-start'));
      const start = store.claimNextRunnable('worker-a')!;
      const startFence = { ...start, sourceState: 'starting' as const };
      assert.deepEqual(store.renewClaim({ ...startFence, ownerResourceId: 'owner-2' }), { applied: false, reason: 'lease_lost' });
      const fixtureDatabase = new DatabaseSync(databasePath);
      fixtureDatabase.prepare("UPDATE career_commands SET start_dispatch_state = 'dispatched' WHERE command_id = ?").run(start.commandId);
      fixtureDatabase.close();
      for (const stale of [
        { ...startFence, ownerResourceId: 'owner-2' },
        { ...startFence, leaseOwner: 'worker-b' },
        { ...startFence, claimGeneration: startFence.claimGeneration + 1 },
      ]) assert.deepEqual(store.markRunning(stale), { applied: false, reason: 'lease_lost' });
      assert.equal(store.markRunning(startFence).applied, true);
      const running = { ...start, sourceState: 'running' as const };
      for (const stale of [
        { ...running, ownerResourceId: 'owner-2' },
        { ...running, leaseOwner: 'worker-b' },
        { ...running, claimGeneration: running.claimGeneration + 1 },
      ]) {
        assert.deepEqual(store.renewClaim(stale), { applied: false, reason: 'lease_lost' });
        assert.deepEqual(store.releaseForRetry(stale, 0), { applied: false, reason: 'lease_lost' });
        assert.deepEqual(store.completeClaim(stale, 'succeeded'), { applied: false, reason: 'lease_lost' });
      }
      expireDeadline(start.commandId);
      assert.deepEqual(store.renewClaim(running), { applied: false, reason: 'lease_lost' });
      assert.deepEqual(store.releaseForRetry(running, 0), { applied: false, reason: 'lease_lost' });
      assert.deepEqual(store.completeClaim(running, 'succeeded'), { applied: false, reason: 'lease_lost' });

    }),
  },
  {
    id: 'P1-historical-suspension-retry-resume',
    run: () => withQueueStore(({ store, databasePath }) => {
      const database = new DatabaseSync(databasePath);
      const now = Number(database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get()!.now);
      database.prepare(`
        INSERT INTO career_commands (
          command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id,
          thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state,
          processing_started_at, suspension_generation, blocker_id, created_at, updated_at, queued_at
        ) VALUES ('historical-suspension', 'historical-attempt', 'historical-request', 'job:historical',
          'https://example.com/jobs/historical', 'owner-1', 'thread-1', 'telegram', 'chat-1',
          'suspended', 'run-historical', 'dispatched', ?, 1, 'blocker-1', ?, ?, ?)
      `).run(now - 10, now - 10, now - 10, now - 10);
      database.prepare(`
        UPDATE career_commands
        SET queue_state = 'resuming', claim_generation = 1, lease_owner = 'worker-suspension',
          lease_expires_at = ?, heartbeat_at = ?, processing_deadline_at = ?, updated_at = ?
        WHERE command_id = 'historical-suspension' AND queue_state = 'suspended'
      `).run(now + 60_000, now, now + 60_000, now);
      database.close();

      const suspensionResume = {
        commandId: 'historical-suspension', runId: 'run-historical', ownerResourceId: 'owner-1',
        queueState: 'resuming' as const, leaseOwner: 'worker-suspension', claimGeneration: 1,
        leaseExpiresAt: now + 60_000, heartbeatAt: now,
      };
      assert.equal(store.markRunning({ ...suspensionResume, sourceState: 'resuming' }).applied, true);
      assert.equal(store.releaseForRetry({ ...suspensionResume, sourceState: 'running' }, 0).applied, true);
      const retryResume = store.claimNextRunnable('worker-retry')!;
      assert.equal(retryResume.queueState, 'resuming');
      const inspect = new DatabaseSync(databasePath, { readOnly: true });
      const persisted = inspect.prepare("SELECT suspension_generation, blocker_id FROM career_commands WHERE command_id='historical-suspension'").get()!;
      inspect.close();
      assert.deepEqual({ ...persisted }, { suspension_generation: 1, blocker_id: null });
    }),
  },
  {
    id: 'P12-guarded-timeout-transitions',
    run: async () => withQueueStore(async ({ store, databasePath }) => {
      for (const id of ['timeout-starting', 'timeout-running', 'timeout-retry', 'timeout-resuming']) store.enqueueCommand(queueInput(id));
      store.claimNextRunnable('worker-starting');
      const running = store.claimNextRunnable('worker-running')!;
      dispatchAndMarkRunning(store, databasePath, running);
      const retry = store.claimNextRunnable('worker-retry')!;
      dispatchAndMarkRunning(store, databasePath, retry);
      store.releaseForRetry({ ...retry, sourceState: 'running' }, 1_000);
      const resume = store.claimNextRunnable('worker-resume')!;
      dispatchAndMarkRunning(store, databasePath, resume);
      store.releaseForRetry({ ...resume, sourceState: 'running' }, 0);
      assert.equal(store.claimNextRunnable('worker-resume-2')?.queueState, 'resuming');
      await delay(25);
      assert.deepEqual(store.expireProcessingDeadlines(), { transitioned: 4 });
      for (const id of ['timeout-starting', 'timeout-running', 'timeout-retry', 'timeout-resuming']) assert.equal(store.getCommand(id)?.queueState, 'timed_out', id);
      assert.equal(store.expireProcessingDeadlines().transitioned, 0);
    }, { processingDeadlineMs: 15 }),
  },
  {
    id: 'P12-current-suspension-expiry',
    run: () => withQueueStore(({ store, databasePath }) => {
      const database = new DatabaseSync(databasePath);
      const now = Number((database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get() as { now: number }).now);
      const hash = `sha256:${'a'.repeat(64)}`;
      database.prepare("INSERT INTO career_commands (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id, origin_channel, origin_destination, queue_state, run_id, start_dispatch_state, processing_started_at, suspension_generation, blocker_id, created_at, updated_at, queued_at) VALUES ('suspended-expired','suspended-attempt','suspended-request','job:suspended','https://example.com/jobs/suspended','owner-1','thread-1','telegram','chat-1','suspended','run-suspended','dispatched',?,2,'blocker-current',?,?,?)").run(now - 200, now - 200, now - 200, now - 200);
      const insert = database.prepare("INSERT INTO career_suspensions (suspension_id, command_id, run_id, suspended_step, blocker_kind, blocker_state, blocker_schema_version, generation, safe_payload, payload_hash, source_hash, profile_hash, prompt_version, prompt_hash, resume_schema_version, resume_schema_hash, allowed_response, issued_at, expires_at, created_at, updated_at) VALUES (?,'suspended-expired','run-suspended','acquire','reauth_required','pending',1,?,'{}',?,?,?,1,?,1,?,'{}',?,?,?,?)");
      insert.run('blocker-old', 1, hash, hash, hash, hash, hash, now - 200, now - 100, now - 200, now - 200);
      insert.run('blocker-current', 2, hash, hash, hash, hash, hash, now - 50, now + 10_000, now - 50, now - 50);
      database.close();
      assert.deepEqual(store.expireSuspensions(), { transitioned: 0 });
      let inspect = new DatabaseSync(databasePath);
      assert.equal(inspect.prepare("SELECT blocker_state FROM career_suspensions WHERE suspension_id='blocker-old'").get()!.blocker_state, 'pending');
      assert.equal(store.getCommand('suspended-expired')?.queueState, 'suspended');
      inspect.prepare("UPDATE career_suspensions SET expires_at = ? WHERE suspension_id='blocker-current'").run(now - 1);
      inspect.close();
      assert.deepEqual(store.expireSuspensions(), { transitioned: 1 });
      inspect = new DatabaseSync(databasePath, { readOnly: true });
      assert.deepEqual(inspect.prepare('SELECT suspension_id, blocker_state FROM career_suspensions ORDER BY generation').all().map((row) => ({ ...row })), [
        { suspension_id: 'blocker-old', blocker_state: 'pending' },
        { suspension_id: 'blocker-current', blocker_state: 'expired' },
      ]);
      const terminal = inspect.prepare("SELECT queue_state, terminal_generation, error_code FROM career_commands WHERE command_id='suspended-expired'").get();
      assert.deepEqual({ ...terminal }, { queue_state: 'timed_out', terminal_generation: 1, error_code: 'suspension_expired' });
      inspect.close();
    }),
  },
  {
    id: 'P18-authority-order',
    run: async () => {
      const contracts = await loadV0Contracts();
      assert.deepEqual(contracts.V0_DOMAIN_AUTHORITY_ORDER, [
        'application_queue:lifecycle_claim_retry_blocker',
        'mastra_snapshot:workflow_execution_position',
        'stage_journal_and_verified_external_stores:effect_truth',
        'completion_outbox:notification_intent',
        'delivery_record_and_provider_evidence:send_outcome',
        'bounded_memory:conversation_context_only',
      ]);
      assert.deepEqual(contracts.V0_TURN_PRECEDENCE_ORDER, [
        'server_authorization_and_configuration',
        'fresh_typed_operational_read',
        'current_validated_user_intent',
        'timestamped_bootstrap_snapshot',
        'bounded_message_history',
      ]);
      assert.deepEqual(contracts.V0_DEFAULTS, expectedDefaults());
      const retainedCitationRule = contracts.V0_RETENTION_POLICY.rules.find(({ dataClass }: any) => dataClass === 'report_bounded_cited_excerpts');
      assert.deepEqual(retainedCitationRule, { dataClass: 'report_bounded_cited_excerpts', retention: 'until_owner_deletion' });
    },
  },
];

for (const row of rows) {
  test(row.id, { timeout: 90_000 }, row.run);
}

type QueueFixture = { store: CareerStore; databasePath: string };

function withQueueStore<T>(run: (fixture: QueueFixture) => T, options: { leaseMs?: number; processingDeadlineMs?: number } = {}): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-v0-queue-'));
  const databasePath = path.join(dir, 'operational.db');
  const store = new CareerStore(`file:${databasePath}`, options);
  try {
    const result = run({ store, databasePath });
    if (result instanceof Promise) return result.finally(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }) as T;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Task 7 owns dispatch-journal CAS/recovery; Task 4 fixtures persist dispatched evidence through SQLite constraints.
function dispatchAndMarkRunning(store: CareerStore, databasePath: string, claim: NonNullable<ReturnType<CareerStore['claimNextRunnable']>>) {
  const database = new DatabaseSync(databasePath);
  const dispatched = database.prepare(`
    UPDATE career_commands SET start_dispatch_state = 'dispatched'
    WHERE command_id = ? AND run_id = ? AND owner_resource_id = ? AND lease_owner = ?
      AND claim_generation = ? AND queue_state IN ('starting', 'resuming')
  `).run(claim.commandId, claim.runId, claim.ownerResourceId, claim.leaseOwner, claim.claimGeneration);
  database.close();
  assert.equal(dispatched.changes, 1, 'test fixture must exercise persisted claim constraints');
  return store.markRunning({ ...claim, sourceState: claim.queueState });
}

function queueInput(commandId: string) {
  return {
    commandId,
    attemptId: `${commandId}:attempt-1`,
    requestId: `${commandId}:request`,
    canonicalJobKey: `job:${commandId}`,
    canonicalUrl: `https://example.com/jobs/${commandId}`,
    ownerResourceId: 'owner-1',
    threadId: 'thread-1',
    originChannel: 'telegram',
    originDestination: 'chat-1',
  };
}

async function waitForWorkflowRun(workflow: { getWorkflowRunById: (runId: string) => Promise<any> }, runId: string) {
  let stored;
  await waitFor(async () => {
    stored = await workflow.getWorkflowRunById(runId);
    return stored?.status === 'success' || stored?.status === 'failed';
  }, `workflow run ${runId} did not finish`);
  return stored;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, failureMessage: string) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(failureMessage);
}

async function loadV0Contracts(): Promise<any> {
  return import('../src/contracts/v0.ts');
}

function contractFixtures(contracts: any): [string, any, any][] {
  const at = '2026-08-03T12:00:00.000Z';
  const later = '2026-08-03T12:01:00.000Z';
  const retention = '2026-09-02T12:00:00.000Z';
  const hash = `sha256:${'a'.repeat(64)}`;
  const origin = { channel: 'telegram', channelThreadId: 'chat-1', messageId: 'message-1', replyToMessageId: null };
  const identity = { identityAuthority: 'server', resourceId: 'owner-1', threadId: 'thread-1' };
  return [
    ['InboundEventV1Schema', contracts.InboundEventV1Schema, {
      schemaVersion: 1, eventId: 'event-1', sequence: 1, receivedAt: at, payloadHash: hash, ...identity, origin,
      intent: { kind: 'save_job', canonicalUrl: 'https://www.linkedin.com/jobs/view/1' },
      processingResult: { status: 'accepted', kind: 'command', referenceId: 'command-1' },
    }],
    ['CommandV1Schema', contracts.CommandV1Schema, {
      schemaVersion: 1, commandId: 'command-1', attemptId: 'attempt-1', requestId: 'request-1', idempotencyKey: 'save:event-1',
      canonicalJobKey: 'linkedin:1', commandName: 'save_job', arguments: { canonicalUrl: 'https://www.linkedin.com/jobs/view/1' },
      ...identity, origin, queueSequence: 1, state: 'running', terminalGeneration: 0, receivedAt: at, updatedAt: later,
      claim: { generation: 1, leaseOwner: 'worker-1', leaseExpiresAt: later, heartbeatAt: at },
      workflow: { workflowVersion: 'save-job-v1', attempt: 1, runId: 'cc-save-v1:command-1:1', resourceId: 'owner-1', startDispatchState: 'dispatched' },
      progress: { latestStage: 'acquire_evidence', suspensionGeneration: 0, blockerId: null },
      retry: { automaticRepeatsUsed: 0, processingStartedAt: at, processingDeadlineAt: later, nextAttemptAt: null, stage: null, errorClass: null, errorCode: null, stageAttempts: 0, lastSafeError: null },
      references: { completionEnvelopeId: null, deliveryRecordId: null, linkedPriorCommandId: null },
    }],
    ['StageRecordV1Schema', contracts.StageRecordV1Schema, {
      schemaVersion: 1, stageRecordId: 'stage-1', commandId: 'command-1', runId: 'cc-save-v1:command-1:1', stage: 'sheet_review_commit',
      idempotencyKey: 'command-1:sheet_review_commit', state: 'applied', expectedSheetFingerprint: hash, expectedRowVersion: 2,
      externalReference: 'sheet:tracker:row-2', contentHash: hash, safeOutcome: 'effect_verified', plannedAt: at, applyingAt: at,
      completedAt: later, updatedAt: later,
    }],
    ['ResumePayloadV1Schema', contracts.ResumePayloadV1Schema, { schemaVersion: 1, kind: 'confirmation', value: 'ready' }],
    ['BlockerEnvelopeV1Schema', contracts.BlockerEnvelopeV1Schema, {
      schemaVersion: 1, blockerId: 'blocker-1', commandId: 'command-1', runId: 'cc-save-v1:command-1:1', suspendedStep: 'acquire_evidence',
      suspensionGeneration: 1, ...identity, blockerKind: 'reauth_required', state: 'pending', sourceHash: hash, profileHash: hash,
      promptVersion: 1, promptHash: hash, resumeSchemaVersion: 1, resumeSchemaHash: hash,
      allowedResponse: { kind: 'confirmation', choices: ['ready'] }, issuedAt: at, expiresAt: later, acceptedAt: null,
      resumePayload: null, resumePayloadHash: null, safeMessage: 'Reconnect the approved browser session.',
    }],
    ['EvidenceRecordV1Schema', contracts.EvidenceRecordV1Schema, {
      schemaVersion: 1, evidenceId: 'evidence-1', commandId: 'command-1', canonicalUrl: 'https://www.linkedin.com/jobs/view/1',
      acquiredAt: at, retentionDeadline: retention, acquisitionMethod: 'direct_fetch', sourceHash: hash, sourceVersion: 'http-etag-v1', profileHash: hash,
      profileVersion: 'resume-v3', contentType: 'text/html', extractedCharacterCount: 120,
      excerpts: [{ excerptId: 'excerpt-1', text: 'Evidence-backed role requirement.', start: 0, end: 33, hash }],
    }],
    ['ArtifactManifestV1Schema', contracts.ArtifactManifestV1Schema, {
      schemaVersion: 1, artifactId: 'artifact-1', commandId: 'command-1', runId: 'cc-save-v1:command-1:1', auditability: 'auditable_and_traceable',
      canonicalUrl: 'https://www.linkedin.com/jobs/view/1', acquiredAt: at, evidenceIds: ['evidence-1'], sourceHash: hash,
      profileHash: hash, sourceVersion: 'http-etag-v1', profileVersion: 'resume-v3', promptId: 'report-v1', promptVersion: '1',
      schemaId: 'artifact-manifest', modelId: 'google/gemini-2.5-flash', stageRecordIds: ['stage-1'], finalArtifactHash: hash,
      reportReference: 'reports/artifact-1.md',
      citedExcerpts: [{ evidenceId: 'evidence-1', start: 0, end: 33, text: 'Evidence-backed role requirement.', hash }],
      fullPageSnapshotRetained: false,
    }],
    ['CompletionEnvelopeV1Schema', contracts.CompletionEnvelopeV1Schema, {
      schemaVersion: 1, envelopeId: 'envelope-1', envelopeKind: 'terminal', idempotencyKey: 'command-1:run-1:terminal:1',
      commandId: 'command-1', runId: 'cc-save-v1:command-1:1', requestId: 'request-1', terminalGeneration: 1,
      suspensionGeneration: null, ...identity, origin, queueState: 'succeeded', outcome: 'succeeded', latestStage: 'review_commit',
      retry: null, blocker: null, artifacts: [{ artifactId: 'artifact-1', reference: 'reports/artifact-1.md', hash }],
      safeSummary: 'Saved the evidenced job and verified the tracker commit.',
      safeInput: { originalUrl: 'https://www.linkedin.com/jobs/view/1', canonicalUrl: 'https://www.linkedin.com/jobs/view/1' },
      handoff: { evidencedTitle: 'Senior Engineer', evidencedCompany: 'Example Co', finalTrackerStatus: 'pending_review', topicCount: 4, warnings: [], details: { kind: 'success', trackerReference: 'sheet:tracker:row-2', reportReference: 'reports/artifact-1.md' } },
      promptVersions: [{ promptId: 'report-v1', version: '1' }], schemaVersions: [{ schemaId: 'completion-envelope', version: 1 }],
      writes: { completed: ['report', 'topics', 'sheet'], notCompleted: [], priorTrackerStatusPreserved: true, reconciliationRequired: false },
      createdAt: later,
    }],
    ['TurnDeliveryV1Schema', contracts.TurnDeliveryV1Schema, {
      schemaVersion: 1, turnDeliveryId: 'turn-delivery-1', transportEventId: 'event-1', turnId: 'turn-1', deliveryKey: 'turn:event-1',
      ...identity, origin, renderedResponse: 'I queued that job.', responseHash: hash, createdAt: at,
    }],
    ['DeliveryRecordV1Schema', contracts.DeliveryRecordV1Schema, {
      schemaVersion: 1, deliveryRecordId: 'delivery-1', source: { kind: 'completion', envelopeId: 'envelope-1', commandId: 'command-1', runId: 'cc-save-v1:command-1:1' },
      deliveryKey: 'completion:envelope-1', ...identity, origin, state: 'delivered', authorizationRevision: 1, claimGeneration: 1, claimOwner: null,
      claimExpiresAt: null, heartbeatAt: null, renderedResponse: 'Job saved.', responseHash: hash, attemptCount: 1, firstAttemptAt: at,
      nextAttemptAt: null, retryDeadlineAt: later, providerEvidence: { provider: 'telegram', outcome: 'acknowledged', messageId: '100', observedAt: later },
      lastSafeError: null, createdAt: at, updatedAt: later,
    }],
    ['HealthSnapshotV1Schema', contracts.HealthSnapshotV1Schema, {
      schemaVersion: 1, generatedAt: at, status: 'ready', ready: true, degraded: false,
      database: { reachable: true, migrationsComplete: true, schemaVersion: 1 },
      workers: { worker: 'running', reconciler: 'running', dispatcher: 'running' },
      queue: { depth: 1, oldestRunnableAgeSeconds: 10, expiredLeaseCount: 0, expiredLeaseReconciliationCycles: 0, retryWaitCount: 0, suspendedCount: 0 },
      deliveries: { pendingCount: 0, blockedCount: 0, sendUnknownCount: 0, oldestPendingAgeSeconds: 0 },
      capabilities: { browser: 'available', channel: 'available' }, reasons: [],
    }],
    ['RetentionPolicyV1Schema', contracts.RetentionPolicyV1Schema, contracts.V0_RETENTION_POLICY],
  ];
}

function fixture(fixtures: [string, any, any][], name: string) {
  return fixtures.find(([schemaName]) => schemaName === name)![2];
}

function omit<T extends Record<string, any>>(value: T, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function reject(schema: { safeParse: (value: unknown) => { success: boolean } }, payload: unknown, label: string) {
  assert.equal(schema.safeParse(payload).success, false, label);
}

function commandWithDispatch(command: any, state: 'starting' | 'failed' | 'timed_out', startDispatchState: string, reconciled = true) {
  const payload = commandForState(command, state);
  return {
    ...payload,
    workflow: { ...payload.workflow, startDispatchState },
    retry: ['failed', 'timed_out'].includes(state) && startDispatchState === 'start_unknown' && reconciled
      ? { ...payload.retry, errorClass: 'workflow_start', errorCode: 'start_unknown', lastSafeError: 'Workflow start outcome could not be reconciled safely.' }
      : { ...payload.retry, errorClass: null, errorCode: null, lastSafeError: null },
  };
}

function suspensionExpiryTimedOut(command: any) {
  const payload = commandForState(command, 'timed_out');
  return {
    ...payload,
    progress: { ...payload.progress, suspensionGeneration: 1, blockerId: null },
    retry: {
      ...payload.retry,
      processingDeadlineAt: null,
      errorClass: 'blocker',
      errorCode: 'suspension_expired',
      lastSafeError: 'The suspension expired before an accepted response was received.',
    },
  };
}

function commandForState(command: any, state: string) {
  const activeClaim = { generation: 1, leaseOwner: 'worker-1', leaseExpiresAt: command.updatedAt, heartbeatAt: command.receivedAt };
  const noClaim = { generation: 1, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null };
  if (state === 'queued') return { ...command, state, terminalGeneration: 0, claim: noClaim, workflow: { ...command.workflow, runId: null, startDispatchState: 'not_dispatched' }, progress: { ...command.progress, latestStage: null, suspensionGeneration: 0, blockerId: null }, retry: { ...command.retry, processingStartedAt: null, processingDeadlineAt: null, nextAttemptAt: null } };
  if (state === 'suspended') return { ...command, state, terminalGeneration: 0, claim: noClaim, workflow: { ...command.workflow, startDispatchState: 'dispatched' }, progress: { ...command.progress, suspensionGeneration: 1, blockerId: 'blocker-1' }, retry: { ...command.retry, processingDeadlineAt: null, nextAttemptAt: null } };
  if (state === 'resuming') return { ...command, state, terminalGeneration: 0, claim: activeClaim, workflow: { ...command.workflow, startDispatchState: 'dispatched' }, progress: { ...command.progress, suspensionGeneration: 1, blockerId: 'blocker-1' } };
  if (['succeeded', 'failed', 'timed_out'].includes(state)) return { ...command, state, terminalGeneration: 1, claim: noClaim, workflow: { ...command.workflow, startDispatchState: 'dispatched' } };
  if (state === 'retry_wait') return { ...command, state, terminalGeneration: 0, claim: noClaim, workflow: { ...command.workflow, startDispatchState: 'dispatched' }, retry: { ...command.retry, nextAttemptAt: command.updatedAt } };
  return { ...command, state, terminalGeneration: 0, claim: activeClaim, workflow: { ...command.workflow, startDispatchState: state === 'starting' ? 'dispatching' : 'dispatched' } };
}

function acceptedBlocker(blocker: any, resumePayloadHash: string) {
  return { ...blocker, state: 'accepted', acceptedAt: blocker.issuedAt, resumePayload: { schemaVersion: 1, kind: 'confirmation', value: 'ready' }, resumePayloadHash };
}

function blockerForState(blocker: any, state: string, resumePayloadHash: string) {
  return ['accepted', 'applying', 'applied'].includes(state)
    ? { ...acceptedBlocker(blocker, resumePayloadHash), state }
    : { ...blocker, state };
}

function suspensionEnvelope(completion: any) {
  return {
    ...completion,
    envelopeKind: 'suspension', terminalGeneration: null, suspensionGeneration: 1, queueState: 'suspended', outcome: 'blocked', latestStage: 'acquire_evidence',
    blocker: { blockerId: 'blocker-1', kind: 'reauth_required', requiredAction: 'Reconnect.', expiresAt: completion.createdAt },
    handoff: { ...completion.handoff, finalTrackerStatus: null, topicCount: 0, details: { kind: 'suspension', safeReason: 'Reconnect the approved browser session.' } },
  };
}

function previouslySeenEnvelope(completion: any) {
  return {
    ...completion, outcome: 'previously_seen',
    handoff: { ...completion.handoff, details: { kind: 'duplicate', linkedPriorCommandId: 'command-prior', trackerReference: 'sheet:tracker:row-2', reportReference: 'reports/artifact-1.md' } },
  };
}

function failureEnvelope(completion: any, outcome: 'failed' | 'timed_out') {
  return {
    ...completion, queueState: outcome, outcome, latestStage: null, artifacts: [],
    handoff: {
      ...completion.handoff, evidencedTitle: null, evidencedCompany: null, finalTrackerStatus: null, topicCount: 0,
      details: { kind: outcome === 'failed' ? 'failure' : 'timeout', failedStage: null, errorClass: 'workflow_execution', errorCode: outcome, safeError: outcome === 'failed' ? 'The workflow failed safely.' : 'The workflow deadline expired.' },
    },
  };
}

function deliveryForState(delivery: any, state: string) {
  const activeClaim = { claimGeneration: 2, claimOwner: 'dispatcher-1', claimExpiresAt: delivery.updatedAt, heartbeatAt: delivery.createdAt };
  const releasedClaim = { claimOwner: null, claimExpiresAt: null, heartbeatAt: null };
  if (state === 'pending' || state === 'blocked') return { ...delivery, state, ...releasedClaim, renderedResponse: null, responseHash: null, attemptCount: 0, firstAttemptAt: null, providerEvidence: null };
  if (state === 'claimed') return { ...delivery, state, ...activeClaim, renderedResponse: null, responseHash: null, attemptCount: 0, firstAttemptAt: null, providerEvidence: null };
  if (state === 'rendered') return { ...delivery, state, ...releasedClaim, attemptCount: 0, firstAttemptAt: null, providerEvidence: null };
  if (state === 'sending') return { ...delivery, state, ...activeClaim, providerEvidence: null };
  if (state === 'retry_wait') return { ...delivery, state, ...releasedClaim, nextAttemptAt: delivery.updatedAt, providerEvidence: { ...delivery.providerEvidence, outcome: 'definite_failure', messageId: null } };
  if (state === 'send_unknown') return { ...delivery, state, ...releasedClaim, providerEvidence: { ...delivery.providerEvidence, outcome: 'unknown', messageId: null } };
  if (state === 'dead_letter') return { ...delivery, state, ...releasedClaim, providerEvidence: { ...delivery.providerEvidence, outcome: 'definite_failure', messageId: null }, lastSafeError: 'Delivery retries exhausted.' };
  return { ...delivery, state, ...releasedClaim };
}

function expectedDefaults() {
  return {
    queue: { leaseSeconds: 120, heartbeatSeconds: 30, reconciliationSeconds: 30, fallbackPollSeconds: 5, drainDeadlineSeconds: 30, lifecycleStates: ['queued', 'starting', 'running', 'retry_wait', 'suspended', 'resuming', 'succeeded', 'failed', 'timed_out'] },
    workflow: { runsPerCommandAttempt: 1, startDispatchStates: ['not_dispatched', 'dispatching', 'dispatched', 'start_unknown'], blanketRetries: false, sideEffectStepRetries: 0 },
    tracker: { newRowStatus: 'pending_review', commandMarkerColumn: true, rowVersionColumn: true, reconciliation: 'forward_only' },
    authorization: { ownerCount: 1, revocation: 'stop_at_next_authorization_or_side_effect_boundary', studioAndStdioTrust: 'local', identityAuthority: 'server_only' },
    retry: { automaticRepeatTokens: 5, automaticProcessingDeadlineSeconds: 1800, directAcquisitionMaxAttempts: 3, browserConnectionMaxAttempts: 3, providerInferenceMaxAttempts: 2, schemaRepairMaxAttempts: 1, unknownSideEffectBlindRepeats: 0, jitter: 'deterministic_full', jitterBaseSeconds: 2, jitterCapSeconds: 60, retryAfterCap: 'remaining_command_deadline' },
    blocker: { suspensionExpirySeconds: 604800, acceptedResponsesPerGeneration: 1 },
    dispatcher: { leaseSeconds: 180, heartbeatSeconds: 30, definiteDeliveryRetries: 5, retryWindowSeconds: 86400, sendUnknownPolicy: 'manual_or_provider_reconciliation' },
    deadlines: { databaseSeconds: 5, directFetchSeconds: 30, browserAcquisitionSeconds: 120, modelRequestSeconds: 120, sheetOrFileSeconds: 30, channelSendSeconds: 15, browserMutexWaitSeconds: 30, humanSuspensionSeconds: 604800 },
    cancellation: { userCancellation: false, gracefulShutdownIsCancellation: false },
    browser: { topLevelRedirects: 3, topLevelWireBytes: 2097152, topLevelDecodedBytes: 5242880, subresourceBytes: 5242880, aggregateTransferBytes: 26214400, extractedCharacters: 500000, profileDirectoryMode: '0700', secretFileMode: '0600', failOnClickThrough: true, screenshots: false, mutexScope: 'global', ownedTabs: 1, allowedOperations: ['browser_goto', 'browser_wait', 'browser_snapshot', 'browser_scroll', 'owned_tab_cleanup'] },
    network: { scheme: 'https', defaultPortsOnly: true, topLevelContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'], jsonRequiresVerifiedAdapter: true },
    sheets: { oauthScope: 'https://www.googleapis.com/auth/spreadsheets', driveScope: false, strictTargetBinding: true },
    memory: { lastMessages: 20, generateTitle: false, semanticRecall: false, workingMemory: false, observationalMemory: false, customProcessors: false, automaticSummaries: false, specialistMemory: false },
    runtime: { runtimeSkills: 0, productionScorers: 0, primaryToolPolicy: 'narrow_typed_only' },
    bootstrap: { actionableItems: 20, recentTerminalItems: 5, storageUnavailable: 'fail_closed' },
    retention: { standaloneEvidenceDays: 30, terminalOperationalRecordsDays: 90, deliveredDeliveryRecordsDays: 90, resolvedOutboxDays: 90, conversationAfterActivityDays: 90, structuredLogsDays: 30, unresolvedOutbox: 'until_resolved', reportsTopicsTracker: 'until_owner_deletion', reportCitedExcerpts: 'until_owner_deletion', oauthAndBrowserProfile: 'until_revoke_or_reset', minimalAuditTombstone: 'indefinite' },
    health: { oldestRunnableDegradedSeconds: 300, expiredLeaseDegradedReconciliationCycles: 2, pendingDeliveryDegradedSeconds: 900 },
    storage: { operationalBackend: 'absolute_local_file', remoteLibsql: false },
    intake: { globalFifoConsumers: 1, rawChannelUpdateRetention: 'discard_after_validation' },
    artifacts: { claim: 'auditable_and_traceable_not_reproducible', encryptedFullPageSnapshot: false },
  };
}

function databaseSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((row) => ({ ...row }));
    const data: Record<string, unknown[]> = {};
    for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name='schema_migrations' OR name LIKE 'career_%') ORDER BY name").all() as Array<{ name: string }>) {
      data[name] = database.prepare(`SELECT * FROM "${name}"`).all().map((row) => ({ ...row }));
    }
    return { schema, data };
  } finally { database.close(); }
}

function dbMessage(id: string, role: 'user' | 'assistant', parts: Record<string, unknown>[]) {
  return {
    id,
    role,
    threadId: 'thread-1',
    resourceId: 'owner-1',
    createdAt: new Date(),
    content: { format: 2, parts },
  };
}

function toolInvocation(state: 'call' | 'result', toolCallId: string, result?: string) {
  return {
    type: 'tool-invocation',
    toolInvocation: {
      state,
      toolCallId,
      toolName: 'fixtureLookup',
      args: {},
      ...(state === 'result' ? { result } : {}),
    },
  };
}
