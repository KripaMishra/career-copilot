import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { assertJobUrl, jobSiteFor } from '../tools/job-url.ts';
import { type BrowserDriver, BrowserGuardError, browserDriver, isConnectionLost } from './driver.ts';

export const BROWSER_MAX_MODEL_CHARS = 60_000;
export const BROWSER_CONNECT_ATTEMPTS = 3;
export const BROWSER_CONNECT_BASE_DELAY_MS = 200;
const MAX_REDACTED_EVIDENCE = 500;

/** In-process global mutex: the shared authenticated browser is used by one action at a time. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    return previous.then(() => operation()).finally(release);
  }
}
export const browserMutex = new AsyncMutex();

export function redactBrowserEvidence(value: string): string {
  // Bounded and token-masked before anything is persisted or surfaced.
  return value.slice(0, MAX_REDACTED_EVIDENCE).replace(/\b\S{24,}\b/g, '[redacted]');
}

export function classifyBrowserFailure(error: unknown, phase: 'connect' | 'navigate' | 'read'): BrowserGuardError {
  if (error instanceof BrowserGuardError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const evidence = redactBrowserEvidence(message);
  if (phase === 'connect' && isConnectionLost(error)) return new BrowserGuardError('transient', 'connect_failed', evidence, 'Browser connection failed (transient).');
  if (phase === 'connect') return new BrowserGuardError('blocked', 'browser_unreachable', evidence, 'Browser session is not reachable.');
  // Navigate/read: timeouts, auth, CAPTCHA, MFA, consent, DOM ambiguity => blocked
  // (never bypass, never auto-retry). The raw message goes only into redacted
  // evidence — browser errors routinely embed token-bearing URLs.
  return new BrowserGuardError('blocked', phase === 'navigate' ? 'navigation_failed' : 'read_failed', evidence, `Browser ${phase} stopped.`);
}

async function withConnectRetry(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await operation(); return; }
    catch (error) {
      const classified = classifyBrowserFailure(error, 'connect');
      if (classified.kind !== 'transient') throw classified;
      if (attempt >= BROWSER_CONNECT_ATTEMPTS) throw new BrowserGuardError('blocked', 'connect_retries_exhausted', classified.evidence, 'Browser connection failed after repeated attempts.');
      await new Promise((resolve) => setTimeout(resolve, BROWSER_CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 40)));
    }
  }
}

function toForbidden(error: unknown): BrowserGuardError {
  if (error instanceof BrowserGuardError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/host is not supported/i.test(message)) return new BrowserGuardError('forbidden', 'unsupported_host', '', message);
  return new BrowserGuardError('forbidden', 'url_invalid', '', message || 'Invalid URL.');
}

/**
 * The single guarded, read-only browser tool. Site controls + verify-before-act
 * reuse the save-pipeline job-site validation (LinkedIn/Foundit/Cutshort/Naukri/
 * Indeed, HTTPS only). Every action is serialized through the shared global mutex.
 */
export function createGuardedBrowserTool(driver: BrowserDriver = browserDriver()) {
  return createTool({
    id: 'browser_read',
    description:
      'Read bounded content from an authorized job board through a guarded, shared authenticated browser. Read-only: it navigates and reads the page accessibility tree; it never submits forms, types text, or runs scripts. Rejects unsupported or non-HTTPS hosts, and stops (without retry or bypass) on auth, CAPTCHA, consent, redirects off-site, timeouts, or DOM ambiguity. Transient connection losses are reconnected and retried boundedly.',
    inputSchema: z.object({ url: z.string().url() }),
    outputSchema: z.object({ url: z.string(), text: z.string() }),
    execute: async ({ url }) =>
      browserMutex.run(async () => {
        let expected: URL;
        try { expected = assertJobUrl(url); } catch (error) { throw toForbidden(error); }
        const site = jobSiteFor(expected.hostname);
        if (!site) throw new BrowserGuardError('forbidden', 'unsupported_host', '', `Host ${expected.hostname} is not an authorized job site.`);
        let finalUrl: string;
        for (let attempt = 1; ; attempt++) {
          try {
            await withConnectRetry(async () => driver.open());
            finalUrl = await driver.navigateTo(expected.href);
            break;
          } catch (error) {
            const classified = classifyBrowserFailure(error, 'navigate');
            if (classified.kind === 'transient' && attempt < BROWSER_CONNECT_ATTEMPTS) {
              // Connection lost mid-navigate: loop reconnects via open() and retries.
              continue;
            }
            if (classified.kind === 'transient') throw new BrowserGuardError('blocked', 'session_lost_after_retries', classified.evidence, 'Browser connection kept dropping during navigation.');
            throw classified;
          }
        }
        let finalHost: string;
        try { finalHost = new URL(finalUrl).hostname; }
        catch { throw new BrowserGuardError('blocked', 'invalid_final_url', redactBrowserEvidence(finalUrl), 'Browser returned an invalid final URL.'); }
        const finalSite = jobSiteFor(finalHost);
        if (!finalSite || finalSite !== site) throw new BrowserGuardError('blocked', 'redirect_off_site', redactBrowserEvidence(finalUrl), `Browser redirect left the authorized site (${site}).`);
        let text: string;
        try { text = await driver.readSnapshot(BROWSER_MAX_MODEL_CHARS); }
        catch (error) {
          const classified = classifyBrowserFailure(error, 'read');
          if (classified.kind === 'transient') throw new BrowserGuardError('blocked', 'session_lost_on_read', classified.evidence, 'Browser connection was lost while reading the page.');
          throw classified;
        }
        return { url: finalUrl, text: text.slice(0, BROWSER_MAX_MODEL_CHARS) };
      }),
  });
}
