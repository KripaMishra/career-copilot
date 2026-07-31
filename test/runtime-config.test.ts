import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveRuntimeConfig } from '../src/runtime-config.ts';

test('derives absolute local database and workspace paths', () => {
  const dataDir = path.join('tmp', 'career-copilot');
  const config = resolveRuntimeConfig({ dataDir });
  const absoluteDataDir = path.resolve(dataDir);

  assert.equal(config.dataDir, absoluteDataDir);
  assert.equal(config.workspacePath, path.join(absoluteDataDir, 'workspace'));
  assert.equal(config.databaseUrl, `file:${path.join(absoluteDataDir, 'mastra.db')}`);
});

test('creates the data directory for local storage', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-copilot-'));
  fs.rmSync(dataDir, { recursive: true });

  resolveRuntimeConfig({ dataDir });

  assert.equal(fs.statSync(dataDir).isDirectory(), true);
  fs.rmSync(dataDir, { recursive: true });
});

test('keeps an explicitly configured database URL', () => {
  const databaseUrl = 'libsql://career-copilot.example.turso.io';

  assert.equal(
    resolveRuntimeConfig({ dataDir: '/tmp/career-copilot', databaseUrl }).databaseUrl,
    databaseUrl,
  );
});

test('separates approved read-only profile paths from writable report and topic paths', () => {
  const config = resolveRuntimeConfig({
    dataDir: '/tmp/career-copilot-runtime',
    profileDir: '/tmp/career-profile',
    reportsDir: '/tmp/career-reports',
    topicsDir: '/tmp/career-topics',
  });
  assert.equal(config.profilePath, path.resolve('/tmp/career-profile'));
  assert.equal(config.reportsPath, path.resolve('/tmp/career-reports'));
  assert.equal(config.topicsPath, path.resolve('/tmp/career-topics'));
  assert.notEqual(config.profilePath, config.reportsPath);
  assert.notEqual(config.profilePath, config.topicsPath);
});

test('fails closed for startup when required deployment configuration is absent', () => {
  assert.throws(
    () => resolveRuntimeConfig({ requireDeployment: true, env: {} }),
    /MASTRA_DATABASE_URL|TELEGRAM_BOT_TOKEN|GOOGLE_SHEETS_SPREADSHEET_ID/,
  );
});

test('accepts explicit deployment configuration without reading process environment', () => {
  const config = resolveRuntimeConfig({
    requireDeployment: true,
    env: {
      MASTRA_DATABASE_URL: 'file:/tmp/career-copilot.db',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_ALLOWED_USER_IDS: '123',
      CAREER_COPILOT_PRIVATE_CHAT_IDS: '456',
      GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet',
      GOOGLE_SHEETS_TRACKER_TAB: 'Applications',
      GOOGLE_SHEETS_APPLICATION_LOG_TAB: 'Application Log',
      GOOGLE_SHEETS_TOPICS_TAB: 'Topics',
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh',
      CAREER_COPILOT_PROFILE_DIR: '/tmp/profile',
      CAREER_COPILOT_REPORTS_DIR: '/tmp/reports',
      CAREER_COPILOT_TOPICS_DIR: '/tmp/topics',
    },
  });
  assert.equal(config.databaseUrl, 'file:/tmp/career-copilot.db');
  assert.equal(config.sheetsTarget.spreadsheetId, 'sheet');
});

test('rejects relative file database URLs', () => {
  assert.throws(
    () => resolveRuntimeConfig({ databaseUrl: 'file:./mastra.db' }),
    /absolute file URL/,
  );
});
