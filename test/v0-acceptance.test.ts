import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { AgentBrowser } from '@mastra/agent-browser';
import { MessageList } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

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

const rows: AcceptanceRow[] = [
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
