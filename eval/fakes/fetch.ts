import type { FetchPlan } from './schemas/fixture.ts';

/**
 * Fetch/DNS fake — injected into the REAL acquireJobText policy code via
 * FetchDeps ({ fetch, resolve }). The production URL/DNS/redirect/content-type/
 * size policy runs against a scripted transport; the fake only decides what the
 * network would have returned.
 *
 * Redirect chains are represented as a plan graph: the plan for URL A may carry
 * one `redirect` to URL B; the policy re-requests B, whose plan carries the
 * next redirect or the final body. The policy itself enforces same-site and the
 * 3-hop limit. Timeout/abort plans hang until the policy's AbortSignal fires
 * (mirroring a stalled connection).
 */

export type FetchLedgerEntry = {
  url: string;
  status: number;
  contentType: string;
  bodyBytes: number;
  resolved: string[];
};

export type FetchLedger = { calls: FetchLedgerEntry[] };

export function createFetchFake(plans: FetchPlan[], ledger: FetchLedger) {
  const byUrl = new Map(plans.map((plan) => [plan.url, plan]));

  const resolve = async (host: string): Promise<string[]> => {
    const plan = byUrl.get(`https://${host}/`) ?? byUrl.get(`https://${host}`) ?? [...byUrl.values()].find((candidate) => candidate.url.includes(host));
    return plan && plan.dns.length > 0 ? plan.dns : ['93.184.216.34'];
  };

  const fetch = async (url: URL | string, init: RequestInit = {}): Promise<Response> => {
    const target = typeof url === 'string' ? url : url.href;
    const plan = byUrl.get(target);
    if (!plan) throw new Error(`no fetch plan for ${target}`);
    const signal = init.signal ?? null;
    if (plan.timeout || plan.abort) {
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error(plan.abort ? 'aborted' : 'Job fetch timed out.')); return; }
        signal?.addEventListener('abort', () => reject(new Error(plan.abort ? 'aborted' : 'Job fetch timed out.')), { once: true });
      });
    }
    if (plan.redirect) {
      const headers = new Headers({ location: plan.redirect.location, 'content-type': plan.contentType });
      ledger.calls.push({ url: target, status: plan.redirect.status, contentType: plan.contentType, bodyBytes: 0, resolved: plan.dns });
      return new Response('', { status: plan.redirect.status, headers });
    }
    const body = plan.body;
    ledger.calls.push({ url: target, status: plan.status, contentType: plan.contentType, bodyBytes: Buffer.byteLength(body, 'utf8'), resolved: plan.dns });
    return new Response(body, { status: plan.status, headers: { 'content-type': plan.contentType } });
  };

  return { fetch, resolve };
}
