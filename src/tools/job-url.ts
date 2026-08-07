const supportedJobSites = ['linkedin.com', 'foundit.in', 'cutshort.io', 'naukri.com', 'indeed.com'] as const;
export function jobSiteFor(hostname: string) { const host = hostname.toLowerCase().replace(/\.$/, ''); return supportedJobSites.find((site) => host === site || host.endsWith(`.${site}`)); }
function blockedHostname(hostname: string) { const host = hostname.toLowerCase().replace(/\.$/, ''); return host === 'localhost' || host.endsWith('.localhost') || host === 'local' || host.endsWith('.local') || host === 'metadata.google.internal'; }
export function assertJobUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Job URL must be a valid absolute URL.'); }
  if (url.protocol !== 'https:') throw new Error('Job URL must use HTTPS.');
  if (url.username || url.password || url.port || url.hash) throw new Error('Job URL cannot contain credentials, a non-default port, or a fragment.');
  if (!jobSiteFor(url.hostname) || blockedHostname(url.hostname)) throw new Error('Job URL host is not supported.');
  return url;
}
export function assertSameJobSite(original: URL, redirectedTo: string) { const redirect = assertJobUrl(redirectedTo); if (jobSiteFor(original.hostname) !== jobSiteFor(redirect.hostname)) throw new Error('Job URL redirected to another site.'); return redirect; }
