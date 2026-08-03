import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createCareerCopilotRuntime } from '../src/services/career-runtime.ts';

const localEnv = {
  CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0', CAREER_COPILOT_INTAKE_HASH_KEY: 'k'.repeat(32),
  GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet',
};

test('derives absolute local database and workspace paths', () => {
  const dataDir = path.join('tmp', 'career-copilot');
  const config = resolveRuntimeConfig({ dataDir, env: localEnv });
  const absoluteDataDir = path.resolve(dataDir);

  assert.equal(config.dataDir, absoluteDataDir);
  assert.equal(config.workspacePath, path.join(absoluteDataDir, 'workspace'));
  assert.equal(config.databaseUrl, `file:${path.join(absoluteDataDir, 'mastra.db')}`);
});

test('creates the data directory for local storage', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-copilot-'));
  fs.rmSync(dataDir, { recursive: true });

  resolveRuntimeConfig({ dataDir, env: localEnv });

  assert.equal(fs.statSync(dataDir).isDirectory(), true);
  fs.rmSync(dataDir, { recursive: true });
});

test('rejects remote operational database URLs', () => {
  for (const databaseUrl of ['libsql://career-copilot.example.turso.io', 'https://career-copilot.example']) {
    assert.throws(
      () => resolveRuntimeConfig({ dataDir: '/tmp/career-copilot', databaseUrl, env: {} }),
      /absolute local file/,
    );
  }
});

test('separates approved read-only profile paths from writable report and topic paths', () => {
  const config = resolveRuntimeConfig({
    dataDir: '/tmp/career-copilot-runtime',
    profileDir: '/tmp/career-profile',
    reportsDir: '/tmp/career-reports',
    topicsDir: '/tmp/career-topics', env: localEnv,
  });
  assert.equal(config.profilePath, path.resolve('/tmp/career-profile'));
  assert.equal(config.reportsPath, path.resolve('/tmp/career-reports'));
  assert.equal(config.topicsPath, path.resolve('/tmp/career-topics'));
  assert.notEqual(config.profilePath, config.reportsPath);
  assert.notEqual(config.profilePath, config.topicsPath);
});

test('local configuration fails before runtime construction without stable owner identity and hash key', () => {
  assert.throws(() => resolveRuntimeConfig({ dataDir: '/tmp/career-local-missing', env: {} }), /OWNER_RESOURCE_ID/);
  assert.throws(() => resolveRuntimeConfig({ dataDir: '/tmp/career-local-missing', env: { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner' } }), /INTAKE_HASH_KEY/);
});

test('resolved local configuration constructs a runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-local-runtime-'));
  const runtime = createCareerCopilotRuntime(resolveRuntimeConfig({ dataDir: root, env: localEnv }));
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts email-like API identities and rejects unsafe configured principals', () => {
  const configured = resolveRuntimeConfig({ dataDir: '/tmp/career-api-email', env: { ...localEnv, CAREER_COPILOT_API_IDENTITY: 'owner@example.com' } });
  assert.equal(configured.owner.apiIdentity, 'owner@example.com');
  for (const value of ['bad\nidentity', 'x'.repeat(201)]) {
    assert.throws(() => resolveRuntimeConfig({ dataDir: '/tmp/career-api-invalid', env: { ...localEnv, CAREER_COPILOT_API_IDENTITY: value } }), /API_IDENTITY/);
  }
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
      CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0',
      CAREER_COPILOT_INTAKE_HASH_KEY: 'k'.repeat(32),
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
    () => resolveRuntimeConfig({ databaseUrl: 'file:./mastra.db', env: {} }),
    /absolute local file/,
  );
});

test('fails closed for a missing or short keyed intake hash secret', () => {
  const base = {
    MASTRA_DATABASE_URL: 'file:/tmp/career-copilot.db', TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_ALLOWED_USER_IDS: '123', CAREER_COPILOT_PRIVATE_CHAT_IDS: '456', CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0',
    GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet', GOOGLE_SHEETS_TRACKER_TAB: 'Applications', GOOGLE_SHEETS_APPLICATION_LOG_TAB: 'Application Log', GOOGLE_SHEETS_TOPICS_TAB: 'Topics',
    GOOGLE_OAUTH_CLIENT_ID: 'client', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh',
    CAREER_COPILOT_PROFILE_DIR: '/tmp/profile', CAREER_COPILOT_REPORTS_DIR: '/tmp/reports', CAREER_COPILOT_TOPICS_DIR: '/tmp/topics',
  };
  assert.throws(() => resolveRuntimeConfig({ requireDeployment: true, env: base }), /INTAKE_HASH_KEY/);
  assert.throws(() => resolveRuntimeConfig({ requireDeployment: true, env: { ...base, CAREER_COPILOT_INTAKE_HASH_KEY: 'short' } }), /32 bytes/);
});
