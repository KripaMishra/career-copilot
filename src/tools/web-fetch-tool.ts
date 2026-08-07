import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { assertJobUrl, assertSameJobSite } from './job-url.ts';

export const MAX_DECODED_BYTES = 1_000_000;
export const MAX_MODEL_CHARS = 100_000;
const allowedTypes = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const requestHeaders = { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'CareerCopilot/0.1' } as const;
const blockedIPv4 = new BlockList();
const blockedIPv6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedIPv4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blockedIPv6.addSubnet(network, prefix, 'ipv6');
function privateAddress(address: string) { const type = isIP(address); return type === 0 || (type === 4 ? blockedIPv4.check(address, 'ipv4') : blockedIPv6.check(address, 'ipv6')); }
export function validateJobUrl(value: string) { return assertJobUrl(value); }
export function normalizeResponseStatus(value: number | undefined) { return typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599 ? value : 502; }
type FetchDeps = { fetch?: typeof globalThis.fetch; resolve?: (host: string) => Promise<string[]>; maxDecodedBytes?: number; timeoutMs?: number };
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Job fetch timed out.'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function publicAddresses(host: string, resolve: (host: string) => Promise<string[]>, signal: AbortSignal) { const addresses = await abortable(resolve(host), signal); if (!addresses.length || addresses.some(privateAddress)) throw new Error('Job URL resolves to a private or reserved address.'); return addresses; }
async function pinnedFetch(url: URL, address: string, limit: number, timeoutMs: number, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof httpsRequest>;
    const abort = () => request.destroy(new Error('Job fetch timed out.'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    request = httpsRequest({ hostname: address, port: 443, path: `${url.pathname}${url.search}`, method: 'GET', servername: url.hostname, headers: { ...requestHeaders, host: url.host }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > limit) { request.destroy(new Error('Job response exceeds decoded size limit.')); return; } chunks.push(chunk); });
      response.on('end', () => { cleanup(); resolve(new Response(Buffer.concat(chunks), { status: normalizeResponseStatus(response.statusCode), headers: response.headers as Record<string, string> })); });
      response.on('error', (error) => { cleanup(); reject(error); });
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    request.on('timeout', abort); request.on('error', (error) => { cleanup(); reject(error); }); request.end();
  });
}
async function bodyText(response: Response, limit: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error('Job fetch timed out.');
  const declared = Number(response.headers.get('content-length') ?? '0'); if (declared > limit) throw new Error('Job response exceeds decoded size limit.');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let completed = false;
  const abort = () => { void reader.cancel(new Error('Job fetch timed out.')).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try { while (true) { const next = await reader.read(); if (next.done) { completed = true; break; } total += next.value.byteLength; if (total > limit) throw new Error('Job response exceeds decoded size limit.'); chunks.push(next.value); } }
  finally { signal.removeEventListener('abort', abort); if (!completed) try { await reader.cancel(); } catch { /* best effort */ } reader.releaseLock(); }
  if (signal.aborted) throw new Error('Job fetch timed out.');
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export async function acquireJobText(value: string, deps: FetchDeps = {}) {
  const fetcher = deps.fetch; const resolve = deps.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));
  let url = assertJobUrl(value); const original = url; const limit = deps.maxDecodedBytes ?? MAX_DECODED_BYTES; const timeoutMs = deps.timeoutMs ?? 15_000; const signal = AbortSignal.timeout(timeoutMs);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const addresses = await publicAddresses(url.hostname, resolve, signal);
    const response = fetcher ? await fetcher(url, { redirect: 'manual', headers: requestHeaders, signal }) : await pinnedFetch(url, addresses[0], limit, timeoutMs, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); if (!location) throw new Error('Redirect response has no location.'); url = assertSameJobSite(original, new URL(location, url).href); continue; }
    if (!response.ok) throw Object.assign(new Error(`Job fetch failed (${response.status}).`), { status: response.status });
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase(); if (!allowedTypes.has(contentType)) throw new Error('Job response content type is not supported.');
    const text = await bodyText(response, limit, signal); return { url: url.href, contentType, text: text.slice(0, MAX_MODEL_CHARS) };
  }
  throw new Error('Too many redirects.');
}
export const webFetchTool = createTool({ id: 'web_fetch', description: 'Fetch bounded text from an approved job URL.', inputSchema: z.object({ url: z.string().url() }), outputSchema: z.object({ url: z.string(), contentType: z.string(), text: z.string() }), execute: async ({ url }) => acquireJobText(url) });
