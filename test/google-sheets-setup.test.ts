import assert from 'node:assert/strict';
import test from 'node:test';

import { applicationHeaders, buildSheetSetupPlan } from '../scripts/google-sheets-setup.ts';

const tabs = {
  tracker: 'Applications',
  audit: 'Application Log',
  topics: 'Topics',
};

test('plans a new Career Copilot spreadsheet when no ID is configured', () => {
  assert.deepEqual(buildSheetSetupPlan(undefined, tabs), {
    createSpreadsheet: true,
    missingTabs: ['Applications', 'Application Log', 'Topics'],
  });
  assert.ok(applicationHeaders.includes('Fit Score'));
});

test('adds only missing tabs to an existing spreadsheet', () => {
  assert.deepEqual(buildSheetSetupPlan(['Applications', 'Topics'], tabs), {
    createSpreadsheet: false,
    missingTabs: ['Application Log'],
  });
});
