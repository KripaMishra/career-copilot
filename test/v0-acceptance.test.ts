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
