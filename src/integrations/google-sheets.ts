import { basename } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const TRACKER_HEADERS = ['Job ID', 'Status', 'Title', 'Company', 'Report Path'] as const;
const REQUEST_TIMEOUT_MS = 15_000;
export type SheetRow = Record<string, unknown> & { jobId: string };
export type SheetAdapter = { findByJobId(jobId: string): Promise<SheetRow | null>; write(row: SheetRow): Promise<void> };
const rowFields = [['jobId', 'Job ID'], ['status', 'Status'], ['title', 'Title'], ['company', 'Company'], ['reportPath', 'Report Path']] as const;
function sameRow(actual: SheetRow, expected: SheetRow) { return rowFields.every(([key, header]) => String(actual[key] ?? actual[header] ?? '') === String(expected[key] ?? expected[header] ?? '')); }
export async function upsertSheetRow(adapter: SheetAdapter, row: SheetRow) {
  try { await adapter.write(row); } catch (error) { const readback = await adapter.findByJobId(row.jobId); if (readback && sameRow(readback, row)) return readback; throw error; }
  const readback = await adapter.findByJobId(row.jobId); if (!readback || !sameRow(readback, row)) throw new Error('Sheet write could not be verified.'); return readback;
}
export type SheetsTarget = { spreadsheetId: string; trackerTab: string; auditTab: string; topicsTab: string };
export type SheetsApi = {
  verifyTarget(input: { spreadsheetId: string; tab: string; accessToken: string }): Promise<void>;
  readRows(input: { spreadsheetId: string; tab: string; accessToken: string }): Promise<Array<Record<string, unknown>>>;
  readHeaders?(input: { spreadsheetId: string; tab: string; accessToken: string }): Promise<string[]>;
  appendRow(input: { spreadsheetId: string; tab: string; accessToken: string; row: Record<string, unknown>; headers?: readonly string[] }): Promise<void>;
  updateRow?(input: { spreadsheetId: string; tab: string; accessToken: string; rowNumber: number; row: Record<string, unknown>; headers?: readonly string[] }): Promise<void>;
};
export class GoogleOAuthRefreshProvider {
  private readonly config: { clientId: string; clientSecret: string; refreshToken: string; tokenUrl?: string };
  constructor(config: { clientId: string; clientSecret: string; refreshToken: string; scope?: string; tokenUrl?: string }) { this.config = config; }
  async getAccessToken() {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) throw new Error('Google OAuth reauthorization is required.');
    const response = await fetch(this.config.tokenUrl ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: this.config.refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error('Google OAuth refresh failed.');
    const result = await response.json() as { access_token?: string; scope?: string };
    if (!result.access_token || !(result.scope ?? '').split(' ').includes(SHEETS_SCOPE)) throw new Error('Google OAuth scope is insufficient.');
    return result.access_token;
  }
}
function assertTrackerHeaders(headers: string[]) { if (new Set(headers).size !== headers.length || TRACKER_HEADERS.some((header) => !headers.includes(header))) throw new Error('Google Sheets tracker headers do not match the canonical schema.'); }
function canonicalRow(row: SheetRow): Record<string, unknown> { return { 'Job ID': row.jobId, Status: row.status ?? '', Title: row.title ?? '', Company: row.company ?? '', 'Report Path': row.reportPath ? basename(String(row.reportPath)) : '' }; }
function marker(row: Record<string, unknown>) { return String(row['Job ID'] ?? row.jobId ?? ''); }
function a1Column(index: number) { let value = ''; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + ((current - 1) % 26)) + value; return value; }
export class GoogleSheetsHttpApi implements SheetsApi {
  private readonly baseUrl: string;
  constructor(baseUrl = 'https://sheets.googleapis.com/v4') { this.baseUrl = baseUrl; }
  private async request(pathname: string, token: string, init: RequestInit = {}) { const response = await fetch(`${this.baseUrl}${pathname}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); if (!response.ok) throw new Error(`Google Sheets request failed (${response.status}).`); return response.json() as Promise<Record<string, unknown>>; }
  async verifyTarget(input: { spreadsheetId: string; tab: string; accessToken: string }) { const data = await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}?includeGridData=false&fields=spreadsheetId,sheets(properties(title))`, input.accessToken) as { spreadsheetId?: string; sheets?: Array<{ properties?: { title?: string } }> }; if (data.spreadsheetId !== input.spreadsheetId || !data.sheets?.some((sheet) => sheet.properties?.title === input.tab)) throw new Error('Google Sheets target mismatch.'); }
  async readHeaders(input: { spreadsheetId: string; tab: string; accessToken: string }) { const data = await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}?majorDimension=ROWS`, input.accessToken) as { values?: unknown[][] }; return (data.values?.[0] ?? []).map(String); }
  async readRows(input: { spreadsheetId: string; tab: string; accessToken: string }) { const data = await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}`, input.accessToken) as { values?: unknown[][] }; const values = data.values ?? []; const headers = (values[0] ?? []).map(String); return values.slice(1).map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? '']))); }
  async appendRow(input: { spreadsheetId: string; tab: string; accessToken: string; row: Record<string, unknown>; headers?: readonly string[] }) { const headers = input.headers ?? TRACKER_HEADERS; const values = headers.map((header) => input.row[header] ?? ''); await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, input.accessToken, { method: 'POST', body: JSON.stringify({ values: [values] }) }); }
  async updateRow(input: { spreadsheetId: string; tab: string; accessToken: string; rowNumber: number; row: Record<string, unknown>; headers?: readonly string[] }) { const headers = input.headers ?? TRACKER_HEADERS; const values = headers.map((header) => input.row[header] ?? ''); const endColumn = a1Column(values.length - 1); const range = `${input.tab}!A${input.rowNumber}:${endColumn}${input.rowNumber}`; await this.request(`/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, input.accessToken, { method: 'PUT', body: JSON.stringify({ values: [values] }) }); }
}
export class GoogleSheetsBoundary {
  private readonly options: { target: SheetsTarget; authorize: () => Promise<string>; api: SheetsApi };
  constructor(options: { target: SheetsTarget; authorize: () => Promise<string>; api: SheetsApi }) { this.options = options; }
  private async target() { const token = await this.options.authorize(); if (!token) throw new Error('Google Sheets authorization is unavailable.'); const input = { spreadsheetId: this.options.target.spreadsheetId, tab: this.options.target.trackerTab, accessToken: token }; await this.options.api.verifyTarget(input); const headers = this.options.api.readHeaders ? await this.options.api.readHeaders(input) : TRACKER_HEADERS.slice(); assertTrackerHeaders(headers); return { input, headers }; }
  async findByJobId(jobId: string): Promise<SheetRow | null> { const { input } = await this.target(); const rows = await this.options.api.readRows(input); const found = rows.find((item) => marker(item) === jobId); return found ? ({ ...found, jobId } as SheetRow) : null; }
  async upsert(row: SheetRow) { const { input, headers } = await this.target(); const rows = await this.options.api.readRows(input); const index = rows.findIndex((item) => marker(item) === row.jobId); const mapped = canonicalRow(row); if (index >= 0) { if (!this.options.api.updateRow) throw new Error('Google Sheets API does not support updates.'); await this.options.api.updateRow({ ...input, rowNumber: index + 2, row: { ...rows[index], ...mapped }, headers }); } else await this.options.api.appendRow({ ...input, row: mapped, headers }); const readback = await this.options.api.readRows(input); const found = readback.find((item) => marker(item) === row.jobId); if (!found || !Object.entries(mapped).every(([key, value]) => String(found[key] ?? '') === String(value ?? ''))) throw new Error('Google Sheets write could not be verified.'); return { ...found, jobId: row.jobId } as SheetRow; }
}
export function createGoogleSheetsTools(boundary: GoogleSheetsBoundary) { return { sheets_upsert_job: createTool({ id: 'sheets_upsert_job', description: 'Upsert a job tracker row.', inputSchema: z.object({ row: z.record(z.string(), z.unknown()) }), execute: async ({ row }) => boundary.upsert(row as SheetRow) }) }; }
