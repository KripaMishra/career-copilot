import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CareerJob } from '../services/career-copilot.ts';

function realRoot(root: string): string {
  const absolute = path.resolve(root);
  if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Symlinked workspace roots are rejected.');
  return fs.realpathSync.native(absolute);
}

function assertContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Filesystem path resolves outside its guarded root.');
  }
}

export function assertSafeWorkspaceRoots(profile: string, reports: string, topics: string): void {
  const roots = [profile, reports, topics].map((root) => {
    const absolute = path.resolve(root);
    return fs.existsSync(absolute) ? fs.realpathSync.native(absolute) : absolute;
  });
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const a = path.relative(roots[i], roots[j]);
      const b = path.relative(roots[j], roots[i]);
      if (!a || !b || (!a.startsWith(`..${path.sep}`) && a !== '..') || (!b.startsWith(`..${path.sep}`) && b !== '..')) {
        throw new Error('Filesystem roots must not overlap.');
      }
    }
  }
}

function assertRegularFileInside(root: string, file: string) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Symlinked profile files are rejected.');
  const resolved = fs.realpathSync.native(file);
  assertContained(root, resolved);
  if (!stat.isFile()) throw new Error('Profile path must contain regular files only.');
}

function atomicWrite(file: string, content: string) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

class ApprovedProfileBoundary {
  private readonly root: string;
  constructor(root: string) {
    this.root = realRoot(root);
  }

  async readApproved(): Promise<Record<string, string>> {
    const output: Record<string, string> = {};
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.isSymbolicLink()) throw new Error('Symlinked profile directories are rejected.');
          assertContained(this.root, fs.realpathSync.native(candidate));
          visit(candidate);
        } else {
          assertRegularFileInside(this.root, candidate);
          output[path.relative(this.root, candidate)] = fs.readFileSync(candidate, 'utf8');
        }
      }
    };
    visit(this.root);
    return output;
  }
}

class PrivateReportBoundary {
  private readonly root: string;
  constructor(root: string) { this.root = realRoot(root); }

  async write(input: { job: CareerJob; profile: Record<string, unknown> }): Promise<{ hash: string; path: string }> {
    const content = [
      `URL: ${input.job.url}`,
      `Company: ${input.job.company ?? ''}`,
      `Title: ${input.job.title ?? ''}`,
      `Location: ${input.job.location ?? ''}`,
      `Description: ${input.job.description ?? ''}`,
      `Approved profile sources: ${Object.keys(input.profile).sort().join(', ')}`,
    ].join('\n');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const file = path.join(this.root, `${hash}.md`);
    assertContained(this.root, file);
    atomicWrite(file, content);
    return { hash, path: file };
  }
}

class SharedTopicBoundary {
  private readonly root: string;
  constructor(root: string) { this.root = realRoot(root); }

  async write(input: { job: CareerJob }): Promise<void> {
    const file = path.join(this.root, 'topics.jsonl');
    assertContained(this.root, file);
    const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    records.push(JSON.stringify({ url: input.job.url, company: input.job.company ?? '', title: input.job.title ?? '', location: input.job.location ?? '' }));
    atomicWrite(file, `${records.join('\n')}\n`);
  }
}

export function createCareerFilesystemBoundaries(roots: { profile: string; reports: string; topics: string }) {
  assertSafeWorkspaceRoots(roots.profile, roots.reports, roots.topics);
  if (!fs.existsSync(roots.profile)) throw new Error('Approved profile root does not exist.');
  fs.mkdirSync(roots.reports, { recursive: true });
  fs.mkdirSync(roots.topics, { recursive: true });
  return {
    profile: new ApprovedProfileBoundary(roots.profile),
    report: new PrivateReportBoundary(roots.reports),
    topic: new SharedTopicBoundary(roots.topics),
  };
}
