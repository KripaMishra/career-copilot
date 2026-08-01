import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export type SheetsTarget = { spreadsheetId: string; trackerTab: string; auditTab: string; topicsTab: string };
type AuthorizedRequest = { spreadsheetId: string; tab: string; accessToken: string };

export type SheetsApi = {
  verifyTarget(input: AuthorizedRequest): Promise<void>;
  readRows(input: AuthorizedRequest): Promise<Array<Record<string, unknown>>>;
  appendRow(input: AuthorizedRequest & { row: Record<string, unknown> }): Promise<void>;
  updateRow(input: AuthorizedRequest & { rowNumber: number; row: Record<string, unknown> }): Promise<void>;
};
export type SheetsBoundaryOptions = { target: SheetsTarget; authorize: () => Promise<string>; api: SheetsApi };

const userOwnedFields = new Set(['Priority', 'Follow-up Date', 'Interview Stage', 'Rejection', 'Withdrawal', 'Offer', 'Fit Score']);

export class GoogleSheetsBoundary {
  readonly target: SheetsTarget;
  private readonly authorize: () => Promise<string>;
  private readonly api: SheetsApi;

  constructor(options: SheetsBoundaryOptions) {
    if (!options.target.spreadsheetId || !options.target.trackerTab || !options.target.auditTab || !options.target.topicsTab) {
      throw new Error('Google Sheets spreadsheet and tab targets are required.');
    }
    this.target = { ...options.target };
    this.authorize = options.authorize;
    this.api = options.api;
  }

  private async authorized(tab: string): Promise<AuthorizedRequest> {
    const accessToken = await this.authorize();
    if (!accessToken) throw new Error('Google Sheets authorization is unavailable.');
    if (!this.api.verifyTarget) throw new Error('Google Sheets target verification is required.');
    const request = { spreadsheetId: this.target.spreadsheetId, tab, accessToken };
    await this.api.verifyTarget(request);
    return request;
  }

  async readTracker(): Promise<Array<Record<string, unknown>>> { return this.api.readRows(await this.authorized(this.target.trackerTab)); }

  async updateTrackerRow(rowNumber: number, systemFields: Record<string, unknown>): Promise<void> {
    const request = await this.authorized(this.target.trackerTab);
    const rows = await this.api.readRows(request);
    const existing = rows[rowNumber] ?? {};
    const row = { ...existing };
    for (const [key, value] of Object.entries(systemFields)) if (!userOwnedFields.has(key)) row[key] = value;
    await this.api.updateRow({ ...request, rowNumber, row });
  }

  async verifyTrackerRow(rowNumber: number, status: string): Promise<void> {
    const request = await this.authorized(this.target.trackerTab);
    const verified = await this.api.readRows(request);
    if (String(verified[rowNumber]?.Status ?? '') !== status) throw new Error('Tracker status verification failed.');
  }

  async appendTrackerRow(row: Record<string, unknown>): Promise<void> { await this.api.appendRow({ ...(await this.authorized(this.target.trackerTab)), row: { ...row } }); }
  async appendAudit(row: Record<string, unknown>): Promise<void> { await this.api.appendRow({ ...(await this.authorized(this.target.auditTab)), row: { ...row } }); }
  async appendTopic(row: Record<string, unknown>): Promise<void> { await this.api.appendRow({ ...(await this.authorized(this.target.topicsTab)), row: { ...row } }); }
}

export class GoogleOAuthRefreshProvider {
  private readonly config: { clientId: string; clientSecret: string; refreshToken: string; scope: string; tokenUrl?: string };
  constructor(config: { clientId: string; clientSecret: string; refreshToken: string; scope: string; tokenUrl?: string }) { this.config = config; }

  async getAccessToken(): Promise<string> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) throw new Error('Google OAuth reauthorization is required.');
    const response = await fetch(this.config.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: this.config.refreshToken, grant_type: 'refresh_token' }),
    });
    if (!response.ok) throw new Error('Google OAuth refresh failed.');
    const result = await response.json() as { access_token?: string; scope?: string };
    const scopes = new Set((result.scope ?? '').split(' ').filter(Boolean));
    if (!result.access_token || !scopes.has(this.config.scope)) throw new Error('Google OAuth scope is insufficient.');
    return result.access_token;
  }
}

function a1Column(index: number) {
  let value = '';
  let current = index + 1;
  while (current > 0) { const remainder = (current - 1) % 26; value = String.fromCharCode(65 + remainder) + value; current = Math.floor((current - 1) / 26); }
  return value;
}

export class GoogleSheetsHttpApi implements SheetsApi {
  private readonly baseUrl: string;
  constructor(baseUrl = 'https://sheets.googleapis.com/v4') { this.baseUrl = baseUrl; }

  private async request(pathname: string, accessToken: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, { ...init, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) throw new Error(`Google Sheets request failed (${response.status}).`);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async verifyTarget(input: AuthorizedRequest): Promise<void> {
    const encoded = encodeURIComponent(input.spreadsheetId);
    const data = await this.request(`/spreadsheets/${encoded}?includeGridData=false&fields=spreadsheetId,sheets(properties(title))`, input.accessToken) as { spreadsheetId?: string; sheets?: Array<{ properties?: { title?: string } }> };
    if (data.spreadsheetId !== input.spreadsheetId || !data.sheets?.some((sheet) => sheet.properties?.title === input.tab)) throw new Error('Google Sheets target mismatch.');
  }

  async readRows(input: AuthorizedRequest): Promise<Array<Record<string, unknown>>> {
    const data = await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}`, input.accessToken) as { values?: unknown[][] };
    const values = data.values ?? [];
    const headers = (values[0] ?? []).map(String);
    return values.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  }

  async appendRow(input: AuthorizedRequest & { row: Record<string, unknown> }): Promise<void> {
    const data = await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}`, input.accessToken) as { values?: unknown[][] };
    const headers = ((data.values ?? [])[0] ?? []).map(String);
    const columns = headers.length ? headers : Object.keys(input.row);
    const values = columns.map((header) => input.row[header] ?? '');
    await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, input.accessToken, { method: 'POST', body: JSON.stringify({ values: [values] }) });
  }

  async updateRow(input: AuthorizedRequest & { rowNumber: number; row: Record<string, unknown> }): Promise<void> {
    const headers = Object.keys(input.row);
    const values = headers.map((header) => input.row[header] ?? '');
    const end = a1Column(values.length - 1);
    await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}!A${input.rowNumber + 2}:${end}${input.rowNumber + 2}?valueInputOption=RAW`, input.accessToken, { method: 'PUT', body: JSON.stringify({ values: [values] }) });
  }
}

export function createGoogleSheetsTools(boundary: GoogleSheetsBoundary) {
  return {
    sheets_read_tracker: createTool({ id: 'sheets_read_tracker', description: 'Read approved application tracker rows.', inputSchema: z.object({}), execute: async () => boundary.readTracker() }),
    sheets_append_audit: createTool({ id: 'sheets_append_audit', description: 'Append a non-sensitive application audit record.', inputSchema: z.object({ row: z.record(z.string(), z.unknown()) }), execute: async ({ row }) => boundary.appendAudit(row) }),
  };
}
