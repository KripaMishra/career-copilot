import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const scope = 'https://www.googleapis.com/auth/spreadsheets';
const redirectUri = 'http://127.0.0.1:53682/oauth/callback';

type AuthorizationInput = { clientId: string; redirectUri: string; state: string };
type EnvValues = Record<string, string>;

export function buildGoogleAuthorizationUrl(input: AuthorizationInput): URL {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  }).toString();
  return url;
}

export function updateEnvText(text: string, values: EnvValues): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} contains a newline.`);
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    const entry = `${name}=${value}`;
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
  }
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => console.log(`Open this URL in your browser:\n${url}`));
  child.unref();
}

function waitForAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Google authorization timed out after five minutes.'));
    }, 300_000);
    const finish = (operation: () => void) => {
      clearTimeout(timeout);
      server.close(operation);
    };
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code || url.searchParams.get('state') !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain' }).end('Authorization failed. Return to the terminal.');
        finish(() => reject(new Error(error ?? 'Invalid OAuth callback.')));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('Google Sheets authorization complete. You may close this tab.');
      finish(() => resolve(code));
    });
    server.once('error', reject);
    server.listen(53682, '127.0.0.1');
  });
}

async function main() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  const authorizationUrl = buildGoogleAuthorizationUrl({ clientId, redirectUri, state });
  const codePromise = waitForAuthorizationCode(state);
  console.log(`Opening Google authorization. The OAuth client must allow this redirect URI:\n${redirectUri}`);
  openBrowser(authorizationUrl.toString());
  const code = await codePromise;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const result = await response.json() as { refresh_token?: string; error?: string; error_description?: string };
  if (!response.ok || !result.refresh_token) {
    throw new Error(result.error_description ?? result.error ?? 'Google did not return a refresh token.');
  }

  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.writeFileSync(envPath, updateEnvText(current, {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REFRESH_TOKEN: result.refresh_token,
    GOOGLE_OAUTH_SCOPE: scope,
  }), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  console.log('Google Sheets OAuth refresh token saved to .env.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
