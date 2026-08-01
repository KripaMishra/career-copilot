import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { updateEnvText } from './google-oauth.ts';

const sheetsScope = 'https://www.googleapis.com/auth/spreadsheets';
const apiBase = 'https://sheets.googleapis.com/v4/spreadsheets';

export const applicationHeaders = ['URL', 'Company', 'Title', 'Location', 'Status', 'Report', 'Priority', 'Follow-up Date', 'Interview Stage', 'Rejection', 'Withdrawal', 'Offer', 'Fit Score'];
export const auditHeaders = ['actor', 'timestamp', 'requestId', 'outcome', 'sourceHash', 'artifactHash', 'beforeStatus', 'afterStatus', 'error'];
export const topicHeaders = ['url', 'company', 'title', 'location'];

type SheetTabs = { tracker: string; audit: string; topics: string };
type SetupPlan = { createSpreadsheet: boolean; missingTabs: string[] };

export function buildSheetSetupPlan(existingTitles: string[] | undefined, tabs: SheetTabs): SetupPlan {
  const required = [tabs.tracker, tabs.audit, tabs.topics];
  return {
    createSpreadsheet: existingTitles === undefined,
    missingTabs: existingTitles === undefined ? required : required.filter((title) => !existingTitles.includes(title)),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Run npm run oauth:google first.`);
  return value;
}

async function accessToken(): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: required('GOOGLE_OAUTH_CLIENT_SECRET'),
      refresh_token: required('GOOGLE_OAUTH_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const result = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !result.access_token) throw new Error(result.error_description ?? result.error ?? 'Google OAuth refresh failed.');
  return result.access_token;
}

async function googleRequest<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  const result = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `Google Sheets request failed (${response.status}).`);
  return result;
}

function range(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'!1:1`;
}

async function readHeaders(token: string, spreadsheetId: string, tab: string): Promise<string[]> {
  const result = await googleRequest<{ values?: unknown[][] }>(token, `${apiBase}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range(tab))}`);
  return (result.values?.[0] ?? []).map(String);
}

function assertCompatibleHeaders(tab: string, actual: string[], expected: string[]) {
  if (actual.length && (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))) {
    throw new Error(`${tab} already has a different header row; no headers were overwritten.`);
  }
}

async function writeHeaders(token: string, spreadsheetId: string, tab: string, headers: string[]) {
  await googleRequest(token, `${apiBase}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range(tab))}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
}

async function confirm(message: string): Promise<boolean> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${message}\nType "yes" to continue: `)).trim().toLowerCase() === 'yes'; }
  finally { terminal.close(); }
}

async function main() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const token = await accessToken();
  const tabs: SheetTabs = {
    tracker: process.env.GOOGLE_SHEETS_TRACKER_TAB?.trim() || 'Applications',
    audit: process.env.GOOGLE_SHEETS_APPLICATION_LOG_TAB?.trim() || 'Application Log',
    topics: process.env.GOOGLE_SHEETS_TOPICS_TAB?.trim() || 'Topics',
  };
  let spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  let existingTitles: string[] | undefined;
  const emptyExistingTabs: string[] = [];

  if (spreadsheetId) {
    const metadata = await googleRequest<{ sheets?: Array<{ properties?: { title?: string } }> }>(token, `${apiBase}/${encodeURIComponent(spreadsheetId)}?includeGridData=false&fields=sheets(properties(title))`);
    existingTitles = (metadata.sheets ?? []).flatMap((sheet) => sheet.properties?.title ? [sheet.properties.title] : []);
    const expectedByTab = new Map([[tabs.tracker, applicationHeaders], [tabs.audit, auditHeaders], [tabs.topics, topicHeaders]]);
    for (const [tab, expected] of expectedByTab) {
      if (!existingTitles.includes(tab)) continue;
      const actual = await readHeaders(token, spreadsheetId, tab);
      assertCompatibleHeaders(tab, actual, expected);
      if (!actual.length) emptyExistingTabs.push(tab);
    }
  }

  const plan = buildSheetSetupPlan(existingTitles, tabs);
  const summary = plan.createSpreadsheet
    ? `Create a "Career Copilot" spreadsheet with tabs: ${plan.missingTabs.join(', ')}`
    : `Configure spreadsheet ${spreadsheetId}; add tabs: ${plan.missingTabs.join(', ') || 'none'}; seed empty headers: ${emptyExistingTabs.join(', ') || 'none'}`;
  if (!(await confirm(summary))) {
    console.log('Google Sheets setup cancelled; nothing changed.');
    return;
  }

  if (plan.createSpreadsheet) {
    const created = await googleRequest<{ spreadsheetId: string; spreadsheetUrl?: string }>(token, apiBase, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: 'Career Copilot' },
        sheets: plan.missingTabs.map((title) => ({ properties: { title } })),
      }),
    });
    spreadsheetId = created.spreadsheetId;
    console.log(`Created spreadsheet: ${created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}`);
  } else if (plan.missingTabs.length) {
    await googleRequest(token, `${apiBase}/${encodeURIComponent(spreadsheetId!)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: plan.missingTabs.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
  }

  const headersByTab = new Map([[tabs.tracker, applicationHeaders], [tabs.audit, auditHeaders], [tabs.topics, topicHeaders]]);
  for (const tab of [...plan.missingTabs, ...emptyExistingTabs]) {
    await writeHeaders(token, spreadsheetId!, tab, headersByTab.get(tab)!);
  }

  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.writeFileSync(envPath, updateEnvText(current, {
    GOOGLE_SHEETS_SPREADSHEET_ID: spreadsheetId!,
    GOOGLE_SHEETS_TRACKER_TAB: tabs.tracker,
    GOOGLE_SHEETS_APPLICATION_LOG_TAB: tabs.audit,
    GOOGLE_SHEETS_TOPICS_TAB: tabs.topics,
    GOOGLE_OAUTH_SCOPE: sheetsScope,
  }), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  console.log('Google Sheets setup complete and .env updated.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
