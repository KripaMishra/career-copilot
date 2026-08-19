import { AgentBrowser } from '@mastra/agent-browser';

export type BrowserFailureKind = 'transient' | 'blocked' | 'forbidden';

/**
 * Typed browser failure. `transient` = connection issue, retried boundedly.
 * `blocked` = auth/CAPTCHA/MFA/consent/redirect/timeout/DOM ambiguity: stop,
 * never bypass or auto-retry. `forbidden` = unauthorized host/action: fail closed.
 */
export class BrowserGuardError extends Error {
  readonly kind: BrowserFailureKind;
  readonly reason: string;
  readonly evidence: string;
  constructor(kind: BrowserFailureKind, reason: string, evidence = '', message?: string) {
    super(message ?? `${kind}:${reason}`);
    this.name = 'BrowserGuardError';
    this.kind = kind;
    this.reason = reason;
    this.evidence = evidence;
  }
}

export interface BrowserDriver {
  readonly cdpUrl: string | null;
  /** Connect to the authenticated browser. Throws when no cdpUrl is configured. */
  open(): Promise<void>;
  /** Navigate and return the final URL after redirects. */
  navigateTo(url: string): Promise<string>;
  /** Read the accessibility-tree snapshot, bounded to maxChars. */
  readSnapshot(maxChars: number): Promise<string>;
  close(): Promise<void>;
}

type BrowserManager = Awaited<ReturnType<AgentBrowser['getManagerForThread']>>;

export function browserDriver(options: { cdpUrl?: string } = {}): BrowserDriver {
  const cdpUrl = options.cdpUrl ?? process.env.BROWSER_CDP_URL?.trim() ?? '';
  return new AgentBrowserDriver(cdpUrl || null);
}

class AgentBrowserDriver implements BrowserDriver {
  private browser: AgentBrowser | null = null;
  private manager: BrowserManager | null = null;
  readonly cdpUrl: string | null;
  constructor(cdpUrl: string | null) { this.cdpUrl = cdpUrl; }

  async open(): Promise<void> {
    if (!this.cdpUrl) throw new BrowserGuardError('forbidden', 'browser_not_configured', '', 'BROWSER_CDP_URL is not configured; no authenticated browser session is available.');
    if (this.manager) return;
    const browser = new AgentBrowser({ cdpUrl: this.cdpUrl, scope: 'shared' });
    try {
      // connectOverCDP under the hood: attaches to the externally launched
      // authenticated Chrome (fetches /json/version, no local Chromium binary).
      await browser.ensureReady();
      this.manager = await browser.getManagerForThread();
      this.browser = browser;
    } catch (error) {
      try { await browser.close(); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  private requireManager(): BrowserManager {
    if (!this.manager) throw new BrowserGuardError('blocked', 'browser_not_open', '', 'Browser session is not connected.');
    return this.manager;
  }

  async navigateTo(url: string): Promise<string> {
    const manager = this.requireManager();
    await manager.navigate(url);
    return manager.getUrl();
  }

  async readSnapshot(maxChars: number): Promise<string> {
    const manager = this.requireManager();
    let text = manager.getLastSnapshot();
    if (!text) text = (await manager.getSnapshot({ compact: true })).tree;
    return text.trim().slice(0, maxChars);
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = this.manager = null;
    if (browser) await browser.close();
  }
}
