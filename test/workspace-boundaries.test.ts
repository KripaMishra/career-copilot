import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCareerFilesystemBoundaries,
  assertSafeWorkspaceRoots,
} from '../src/integrations/local-files.ts';

test('rejects overlapping workspace roots and symlink escapes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-roots-'));
  assert.throws(() => assertSafeWorkspaceRoots(dir, path.join(dir, 'reports'), path.join(dir, 'topics')), /overlap/);
  const profile = path.join(dir, 'profile');
  const reports = path.join(dir, 'reports');
  const topics = path.join(dir, 'topics');
  fs.mkdirSync(profile);
  fs.mkdirSync(reports);
  fs.mkdirSync(topics);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'career-outside-'));
  fs.symlinkSync(outside, path.join(profile, 'escape'));
  const boundaries = createCareerFilesystemBoundaries({ profile, reports, topics });
  await assert.rejects(boundaries.profile.readApproved(), /outside|[Ss]ymlink/);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

test('reads profiles and writes reports/topics only in their guarded roots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-roots-'));
  const profile = path.join(dir, 'profile');
  const reports = path.join(dir, 'reports');
  const topics = path.join(dir, 'topics');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'resume.md'), 'verified profile');
  const boundaries = createCareerFilesystemBoundaries({ profile, reports, topics });
  const read = await boundaries.profile.readApproved();
  assert.equal(read['resume.md'], 'verified profile');
  const report = await boundaries.report.write({
    job: { url: 'https://linkedin.com/jobs/1', company: '', title: '', location: '' },
    profile: read,
  });
  await boundaries.topic.write({ job: { url: 'https://linkedin.com/jobs/1', company: '', title: '', location: '' } });
  assert.equal(fs.readdirSync(reports).length, 1);
  assert.equal(fs.readdirSync(topics).length, 1);
  assert.ok(report.hash);
  fs.rmSync(dir, { recursive: true });
});
