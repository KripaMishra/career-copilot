import assert from 'node:assert/strict';
import test from 'node:test';

import { GoogleSheetsBoundary } from '../src/google-sheets.ts';

test('binds every operation to configured tabs and runtime-only OAuth', async () => {
  const calls: Array<{ tab: string; operation: string; token?: string }> = [];
  const boundary = new GoogleSheetsBoundary({
    target: { spreadsheetId: 'sheet-1', trackerTab: 'Applications', auditTab: 'Application Log', topicsTab: 'Topics' },
    authorize: async () => 'access-token',
    api: {
      verifyTarget: async () => {},
      readRows: async ({ tab, accessToken }) => { calls.push({ tab, operation: 'read', token: accessToken }); return []; },
      appendRow: async ({ tab, accessToken }) => { calls.push({ tab, operation: 'append', token: accessToken }); },
      updateRow: async ({ tab, accessToken }) => { calls.push({ tab, operation: 'update', token: accessToken }); },
    },
  });

  await boundary.readTracker();
  await boundary.appendAudit({ requestId: 'r1', outcome: 'accepted' });
  assert.deepEqual(calls.map(({ tab, operation }) => [tab, operation]), [
    ['Applications', 'read'], ['Application Log', 'append'],
  ]);
  assert.equal(JSON.stringify(boundary).includes('access-token'), false);
});

test('preserves all user-owned tracker fields while updating system fields', async () => {
  let updated: Record<string, unknown> | undefined;
  const rows = [{ Company: 'Acme', Status: 'saved', Priority: 'High', 'Follow-up Date': 'tomorrow', 'Fit Score': 4 }];
  const boundary = new GoogleSheetsBoundary({
    target: { spreadsheetId: 'sheet-1', trackerTab: 'Applications', auditTab: 'Log', topicsTab: 'Topics' },
    authorize: async () => 'token',
    api: {
      verifyTarget: async () => {},
      readRows: async () => rows,
      appendRow: async () => {},
      updateRow: async ({ row }) => { updated = row; rows[0] = row; },
    },
  });

  await boundary.updateTrackerRow(0, { Status: 'reviewed', Report: 'report text' });
  assert.deepEqual(updated, {
    Company: 'Acme', Status: 'reviewed', Priority: 'High', 'Follow-up Date': 'tomorrow', 'Fit Score': 4, Report: 'report text',
  });
});

test('requires target verification before any Sheets operation', async () => {
  const boundary = new GoogleSheetsBoundary({
    target: { spreadsheetId: 'sheet-1', trackerTab: 'Applications', auditTab: 'Log', topicsTab: 'Topics' },
    authorize: async () => 'token',
    api: {
      readRows: async () => [],
      appendRow: async () => {},
      updateRow: async () => {},
    },
  });
  await assert.rejects(boundary.readTracker(), /target verification/);
});

test('rejects a mismatched verified spreadsheet target', async () => {
  const boundary = new GoogleSheetsBoundary({
    target: { spreadsheetId: 'sheet-1', trackerTab: 'Applications', auditTab: 'Log', topicsTab: 'Topics' },
    authorize: async () => 'token',
    api: {
      verifyTarget: async ({ spreadsheetId }) => { if (spreadsheetId !== 'sheet-1') throw new Error('target mismatch'); else throw new Error('target mismatch'); },
      readRows: async () => [], appendRow: async () => {}, updateRow: async () => {},
    },
  });
  await assert.rejects(boundary.readTracker(), /target mismatch/);
});

test('fails closed when OAuth is unavailable', async () => {
  let writes = 0;
  const boundary = new GoogleSheetsBoundary({
    target: { spreadsheetId: 'sheet-1', trackerTab: 'Applications', auditTab: 'Log', topicsTab: 'Topics' },
    authorize: async () => { throw new Error('reauthorization required'); },
    api: { verifyTarget: async () => {}, readRows: async () => [], appendRow: async () => { writes++; }, updateRow: async () => { writes++; } },
  });
  await assert.rejects(boundary.appendAudit({ requestId: 'r1' }), /reauthorization required/);
  assert.equal(writes, 0);
});
