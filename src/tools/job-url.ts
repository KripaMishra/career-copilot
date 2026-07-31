const supportedJobSites = [
  'linkedin.com',
  'foundit.in',
  'cutshort.io',
  'naukri.com',
  'indeed.com',
] as const;

function jobSiteFor(hostname: string) {
  const normalizedHost = hostname.toLowerCase();

  return supportedJobSites.find(
    (site) => normalizedHost === site || normalizedHost.endsWith(`.${site}`),
  );
}

export function assertJobUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('Job URL must be a valid absolute URL.');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Job URL must use HTTPS.');
  }

  if (!jobSiteFor(url.hostname)) {
    throw new Error('Job URL host is not supported.');
  }

  return url;
}

export function assertSameJobSite(original: URL, redirectedTo: string) {
  const redirect = assertJobUrl(redirectedTo);

  if (jobSiteFor(original.hostname) !== jobSiteFor(redirect.hostname)) {
    throw new Error('Job URL redirected to another site.');
  }

  return redirect;
}
