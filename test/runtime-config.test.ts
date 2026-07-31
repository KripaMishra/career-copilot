import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveRuntimeConfig } from '../src/config/runtime.ts';

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

test('rejects relative file database URLs', () => {
  assert.throws(
    () => resolveRuntimeConfig({ databaseUrl: 'file:./mastra.db' }),
    /absolute file URL/,
  );
});
