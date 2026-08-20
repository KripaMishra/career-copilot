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

const CONN_LOST_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const CONN_LOST_RE = /failed to connect via cdp|connectovercdp|browser disconnected|target closed|socket hang up/i;

/** True when the error indicates the shared browser/CDP connection itself is gone. */
export function isConnectionLost(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return CONN_LOST_CODES.has(code) || CONN_LOST_RE.test(message);
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

/** A minimal shape that can yield a fresh accessibility-tree snapshot. */
export interface FreshSnapshotSource {
  getSnapshot(options?: { compact?: boolean }): Promise<{ tree: string }>;
}

export async function readSnapshotTree(manager: FreshSnapshotSource, maxChars: number): Promise<string> {
  // Always request a fresh snapshot. agent-browser's navigate() never refreshes
  // its cached lastSnapshot (only getSnapshot writes it), so reusing the cache
  // after navigation would attribute the previous page's content to the new URL.
  const tree = (await manager.getSnapshot({ compact: true })).tree;
  return tree.trim().slice(0, maxChars);
}

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

  /** Drop the session after the connection is lost so the next open() reconnects. */
  private async invalidateOnDisconnect(error: unknown): Promise<void> {
    if (!isConnectionLost(error)) return;
    try { await this.close(); this.browser = this.manager = null; } catch { this.browser = this.manager = null; }
  }

  async navigateTo(url: string): Promise<string> {
    const manager = this.requireManager();
    try {
      await manager.navigate(url);
      return manager.getUrl();
    } catch (error) {
      await this.invalidateOnDisconnect(error);
      throw error;
    }
  }

  async readSnapshot(maxChars: number): Promise<string> {
    const manager = this.requireManager();
    try {
      return await readSnapshotTree(manager, maxChars);
    } catch (error) {
      await this.invalidateOnDisconnect(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.manager = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close();
  }
}
