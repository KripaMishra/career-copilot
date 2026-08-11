import type { SheetPlan } from './schemas/fixture.ts';
import type { SheetRow } from '../../src/integrations/google-sheets.ts';

/**
 * Sheets fake — implements the production SheetAdapter contract
 * ({ findByJobId, write }). upsertSheetRow (real code) runs on top: write then
 * read-back verification. Failure modes: auth (fails before any operation),
 * write (fails the write; read-back still succeeds so upsertSheetRow can
 * reconcile), readback (write succeeds, read-back verification fails),
 * ambiguous (write succeeds but the row is not found on read-back).
 */

export type SheetsLedgerEntry = { op: 'write' | 'find'; jobId: string; ok: boolean };

export type SheetsLedger = { calls: SheetsLedgerEntry[] };

export type SheetsFake = {
  adapter: { findByJobId(jobId: string): Promise<SheetRow | null>; write(row: SheetRow): Promise<void> };
  rows: SheetRow[];
};

export function createSheetsFake(plan: SheetPlan, ledger: SheetsLedger): SheetsFake {
  const rows: SheetRow[] = [...plan.rows];
  const failBefore = (message: string): never => {
    throw new Error(message);
  };
  const adapter = {
    async findByJobId(jobId: string): Promise<SheetRow | null> {
      if (plan.failure === 'auth') failBefore('Google Sheets authorization failed.');
      ledger.calls.push({ op: 'find', jobId, ok: true });
      return rows.find((row) => row.jobId === jobId) ?? null;
    },
    async write(row: SheetRow): Promise<void> {
      if (plan.failure === 'auth') failBefore('Google Sheets authorization failed.');
      if (plan.failure === 'write') {
        ledger.calls.push({ op: 'write', jobId: row.jobId, ok: false });
        throw new Error('Google Sheets write failed.');
      }
      ledger.calls.push({ op: 'write', jobId: row.jobId, ok: true });
      if (plan.failure === 'readback' || plan.failure === 'ambiguous') {
        // write accepted but read-back cannot verify the row
        return;
      }
      const index = rows.findIndex((candidate) => candidate.jobId === row.jobId);
      if (index >= 0) rows[index] = { ...rows[index], ...row };
      else rows.push({ ...row });
    },
  };
  return { adapter, rows };
}
