import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, renameSync, writeFileSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

function contained(root: string, candidate: string) { const rel = relative(root, candidate); if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel.startsWith('/')) throw new Error('Filesystem path resolves outside its guarded root.'); }
function safeRoot(root: string) { const abs = resolve(root); mkdirSync(abs, { recursive: true, mode: 0o700 }); if (lstatSync(abs).isSymbolicLink()) throw new Error('Symlinked report roots are rejected.'); chmodSync(abs, 0o700); return realpathSync.native(abs); }
export function writeAtomicReport(root: string, jobId: string, content: string) {
  const base = safeRoot(root); const filename = `${jobId.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`; const path = join(base, filename); contained(base, path);
  const temp = join(base, `.${filename}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`); writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 }); renameSync(temp, path);
  return { path, hash: `sha256:${createHash('sha256').update(content).digest('hex')}` };
}
export function assertSafeWorkspaceRoots(profile: string, reports: string, topics: string) { const roots = [profile, reports, topics].map((root) => resolve(root)); for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) { if (roots[i] === roots[j] || roots[i].startsWith(`${roots[j]}/`) || roots[j].startsWith(`${roots[i]}/`)) throw new Error('Filesystem roots must not overlap.'); } }
export function readProfile(root: string) {
  const base = safeRoot(root); const output: Record<string, string> = {};
  const visit = (dir: string) => {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); if (entry.name.startsWith('.')) throw new Error('Hidden profile files are rejected.');
      if (entry.isSymbolicLink()) throw new Error('symlinked profile files are rejected.');
      if (entry.isDirectory()) { contained(base, realpathSync.native(path)); visit(path); continue; }
      if (!entry.isFile() || !['.md', '.txt'].includes(extname(entry.name)) || /credential|secret|private|token|password|passwd|api[_-]?key|id[_-]?rsa/i.test(entry.name)) throw new Error(`unsupported profile file: ${entry.name}.`);
      contained(base, realpathSync.native(path)); chmodSync(path, 0o600); const text = readFileSync(path, 'utf8').slice(0, 100_000);
      if (/-----BEGIN [^-]+-----|(?:api[_ -]?key|password|secret|token)\s*[:=]/i.test(text)) throw new Error('unsafe profile content is rejected.');
      output[relative(base, path)] = text;
    }
  }; visit(base); return output;
}
