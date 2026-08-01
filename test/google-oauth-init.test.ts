import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGoogleAuthorizationUrl, updateEnvText } from '../scripts/google-oauth.ts';

test('builds an offline Google Sheets authorization request', () => {
  const url = buildGoogleAuthorizationUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:53682/oauth/callback',
    state: 'state-value',
  });

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-value');
});

test('updates OAuth values without exposing or deleting unrelated environment values', () => {
  const updated = updateEnvText(
    'EXISTING=value\nGOOGLE_OAUTH_REFRESH_TOKEN=old\n',
    {
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh',
      GOOGLE_OAUTH_SCOPE: 'https://www.googleapis.com/auth/spreadsheets',
    },
  );

  assert.match(updated, /^EXISTING=value$/m);
  assert.match(updated, /^GOOGLE_OAUTH_REFRESH_TOKEN=refresh$/m);
  assert.equal((updated.match(/^GOOGLE_OAUTH_REFRESH_TOKEN=/gm) ?? []).length, 1);
  assert.match(updated, /^GOOGLE_OAUTH_CLIENT_SECRET=secret$/m);
});
