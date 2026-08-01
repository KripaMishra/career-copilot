import assert from 'node:assert/strict';
import test from 'node:test';

import { startScheduleTool } from '../src/tools/schedule-tools.ts';

test('creates schedules in Asia/Kolkata by default', async () => {
  let created: Record<string, unknown> | undefined;
  const mastra = {
    schedules: {
      create: async (input: Record<string, unknown>) => {
        created = input;
        return input;
      },
    },
  };

  await startScheduleTool.execute(
    { schedule: '0 12 * * *', prompt: 'Discover jobs.' },
    { mastra, agent: { threadId: 'thread-1', resourceId: 'owner-1' } },
  );

  assert.equal(created?.timezone, 'Asia/Kolkata');
});

test('rejects invalid schedule timezones', () => {
  assert.throws(() =>
    startScheduleTool.inputSchema.parse({
      schedule: '0 12 * * *',
      prompt: 'Discover jobs.',
      timezone: 'Mars/Olympus_Mons',
    }),
  );
});
