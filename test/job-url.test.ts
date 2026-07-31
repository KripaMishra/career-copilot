import assert from 'node:assert/strict';
import test from 'node:test';

import { assertJobUrl, assertSameJobSite } from '../src/job-url.ts';

test('accepts HTTPS URLs for supported job sites', () => {
  const url = assertJobUrl('https://www.linkedin.com/jobs/view/123');

  assert.equal(url.hostname, 'www.linkedin.com');
});

test('rejects non-HTTPS and unsupported direct job URLs', () => {
  assert.throws(() => assertJobUrl('http://www.linkedin.com/jobs/view/123'));
  assert.throws(() => assertJobUrl('https://example.com/jobs/123'));
});

test('rejects redirects to another supported job site', () => {
  const original = assertJobUrl('https://www.linkedin.com/jobs/view/123');

  assert.throws(() => assertSameJobSite(original, 'https://www.indeed.com/viewjob?jk=123'));
});
