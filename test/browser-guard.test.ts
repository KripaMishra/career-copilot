import test from 'node:test';
import assert from 'node:assert/strict';
import { type BrowserDriver, BrowserGuardError, browserDriver, readSnapshotTree } from '../src/browser/driver.ts';
import { BROWSER_MAX_MODEL_CHARS, createGuardedBrowserTool } from '../src/browser/guard.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake CDP-backed browser: stands in for the authenticated Chrome we cannot reach in tests. */
class FakeDriver implements BrowserDriver {
  cdpUrl = 'http://127.0.0.1:9222';
  calls: string[] = [];
  openFailures = 0;
  navigateTransientFailures = 0;
  openError: Error | null = null;
  navigateError: Error | null = null;
  readError: Error | null = null;
  finalUrl = 'https://www.linkedin.com/jobs/view/1';
  snapshot = 'Senior Platform Engineer\nPython · Kubernetes · Bengaluru\n120 applicants';
  huge = false;
  active = 0;
  maxActive = 0;

  async open() {
    this.calls.push('open');
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.openError) throw this.openError;
      if (this.openFailures > 0) { this.openFailures -= 1; throw Object.assign(new Error('Failed to connect via CDP to http://127.0.0.1:9222'), { code: 'ECONNREFUSED' }); }
      await sleep(2);
    } finally { this.active -= 1; }
  }
  async navigateTo(url: string) {
    this.calls.push(`navigate:${url}`);
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(2);
      if (this.navigateTransientFailures > 0) { this.navigateTransientFailures -= 1; throw new BrowserGuardError('transient', 'session_lost', '', 'Browser disconnected'); }
      if (this.navigateError) throw this.navigateError;
      return this.finalUrl;
    }
    finally { this.active -= 1; }
  }
  async readSnapshot(maxChars: number) {
    this.calls.push('read');
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(2);
      if (this.readError) throw this.readError;
      // huge deliberately ignores maxChars so only the tool's own slice bounds it
      return this.huge ? ''.padEnd(200_000, 'x') : this.snapshot.slice(0, maxChars);
    }
    finally { this.active -= 1; }
  }
  async close() { this.active = this.maxActive = 0; }
}

async function run(tool: ReturnType<typeof createGuardedBrowserTool>, url: string) {
  return (tool as unknown as { execute: (input: { url: string }) => Promise<{ url: string; text: string }> }).execute({ url });
}

test('forbidden host fails closed before any browser action', async () => {
  const driver = new FakeDriver();
  const tool = createGuardedBrowserTool(driver);
  await assert.rejects(() => run(tool, 'https://example.com/'), (error: unknown) => error instanceof BrowserGuardError && error.kind === 'forbidden' && error.reason === 'unsupported_host');
  assert.deepEqual(driver.calls, []);
});

test('non-HTTPS job URL fails closed before any browser action', async () => {
  const driver = new FakeDriver();
  const tool = createGuardedBrowserTool(driver);
  await assert.rejects(() => run(tool, 'http://www.linkedin.com/jobs/view/1'), (error: unknown) => error instanceof BrowserGuardError && error.kind === 'forbidden');
  assert.deepEqual(driver.calls, []);
});

test('happy path reads attributed content from an authorized site', async () => {
  const driver = new FakeDriver();
  const tool = createGuardedBrowserTool(driver);
  const result = await run(tool, 'https://www.linkedin.com/jobs/view/1');
  assert.equal(result.url, driver.finalUrl);
  assert.match(result.text, /Senior Platform Engineer/);
  assert.deepEqual(driver.calls, ['open', `navigate:https://www.linkedin.com/jobs/view/1`, 'read']);
});

test('allowed www host stays authorized after navigation', async () => {
  const driver = new FakeDriver();
  driver.finalUrl = 'https://www.linkedin.com/jobs/view/99?trackingId=abc';
  const result = await run(createGuardedBrowserTool(driver), 'https://linkedin.com/jobs/view/99');
  assert.equal(result.url, driver.finalUrl);
  assert.match(result.text, /Senior Platform Engineer/);
});

test('redirect off the authorized site is blocked with redacted evidence', async () => {
  const driver = new FakeDriver();
  driver.finalUrl = 'https://evil.example.com/phish?tok=123456789012345678901234567890abcdef';
  await assert.rejects(
    () => run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1'),
    (error: unknown) => error instanceof BrowserGuardError && error.kind === 'blocked' && error.reason === 'redirect_off_site' && !error.evidence.includes('123456789012345678901234567890abcdef'),
  );
});

test('snapshot text is bounded to the model char limit', async () => {
  const driver = new FakeDriver();
  driver.huge = true; // returns unsliced 200k chars; only the tool may bound it
  const result = await run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1');
  assert.ok(result.text.length <= BROWSER_MAX_MODEL_CHARS);
  assert.equal(result.text.length, BROWSER_MAX_MODEL_CHARS);
});

test('readSnapshotTree always takes a fresh snapshot, never a stale cache', async () => {
  const source = {
    getLastSnapshot: () => 'STALE previous page content',
    getSnapshot: async () => ({ tree: 'FRESH current page content', refs: {} }),
  };
  const text = await readSnapshotTree(source as unknown as Parameters<typeof readSnapshotTree>[0], 1_000);
  assert.match(text, /FRESH current page content/);
  assert.doesNotMatch(text, /STALE/);
});

test('connection lost mid-navigate is reconnected and retried boundedly', async () => {
  const driver = new FakeDriver();
  driver.navigateTransientFailures = 1;
  const result = await run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1');
  assert.equal(result.url, driver.finalUrl);
  assert.match(result.text, /Senior Platform Engineer/);
  assert.equal(driver.calls.filter((c) => c === 'open').length, 2, 'reconnected after the drop');
  assert.equal(driver.calls.filter((c) => c.startsWith('navigate:')).length, 2, 'navigation was retried');
});

test('transient connection failures retry boundedly then succeed', async () => {
  const driver = new FakeDriver();
  driver.openFailures = 2;
  const result = await run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1');
  assert.equal(driver.calls.filter((call) => call === 'open').length, 3);
  assert.match(result.text, /Senior Platform Engineer/);
});

test('persistent transient connection failure becomes a blocker, no bypass', async () => {
  const driver = new FakeDriver();
  driver.openFailures = 10;
  await assert.rejects(
    () => run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1'),
    (error: unknown) => error instanceof BrowserGuardError && error.kind === 'blocked' && error.reason === 'connect_retries_exhausted',
  );
  assert.equal(driver.calls.filter((call) => call === 'open').length, 3);
});

test('non-transient connect failure stops immediately without retry', async () => {
  const driver = new FakeDriver();
  driver.openError = new Error('CAPTCHA challenge requires manual input');
  await assert.rejects(
    () => run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1'),
    (error: unknown) => error instanceof BrowserGuardError && error.kind === 'blocked' && error.reason === 'browser_unreachable',
  );
  assert.equal(driver.calls.filter((call) => call === 'open').length, 1);
});

test('navigation timeout is a blocker, not auto-retried', async () => {
  const driver = new FakeDriver();
  driver.navigateError = new Error('Navigation timeout of 30000 ms exceeded');
  await assert.rejects(
    () => run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1'),
    (error: unknown) => error instanceof BrowserGuardError && error.kind === 'blocked' && error.reason === 'navigation_failed',
  );
  assert.deepEqual(driver.calls.filter((call) => call.startsWith('navigate')).length, 1);
});

test('global mutex serializes concurrent reads (shared browser)', async () => {
  const driver = new FakeDriver();
  const tool = createGuardedBrowserTool(driver);
  const [, second] = await Promise.allSettled([
    run(tool, 'https://www.linkedin.com/jobs/view/1'),
    run(tool, 'https://linkedin.com/jobs/view/2'),
  ]);
  assert.equal(second.status, 'fulfilled');
  assert.equal(driver.maxActive, 1, 'no two browser actions ever overlapped');
});

test('mutex releases on error so the next read can proceed', async () => {
  const driver = new FakeDriver();
  const tool = createGuardedBrowserTool(driver);
  driver.finalUrl = 'https://evil.example.com/';
  await assert.rejects(() => run(tool, 'https://www.linkedin.com/jobs/view/1'), (error: unknown) => error instanceof BrowserGuardError);
  driver.finalUrl = 'https://www.linkedin.com/jobs/view/2';
  const result = await run(tool, 'https://www.linkedin.com/jobs/view/2');
  assert.match(result.text, /Senior Platform Engineer/);
});

test('connection lost while reading becomes a blocker, next driver open can recover', async () => {
  const driver = new FakeDriver();
  driver.readError = new BrowserGuardError('transient', 'session_lost', '', 'Browser disconnected');
  await assert.rejects(
    () => run(createGuardedBrowserTool(driver), 'https://www.linkedin.com/jobs/view/1'),
    (error: unknown) => error instanceof BrowserGuardError && error.kind === 'blocked' && error.reason === 'session_lost_on_read',
  );
});

test('driver with no CDP URL refuses to open (forbidden)', async () => {
  const driver = browserDriver({ cdpUrl: '' });
  await assert.rejects(() => driver.open(), (error: unknown) => error instanceof BrowserGuardError && error.kind === 'forbidden' && error.reason === 'browser_not_configured');
});
