import fs from 'node:fs';
import path from 'node:path';

export type RuntimeConfigInput = {
  dataDir?: string;
  databaseUrl?: string;
};

function assertPersistentDatabaseUrl(databaseUrl: string) {
  if (databaseUrl.startsWith('file:') && !databaseUrl.startsWith('file:/')) {
    throw new Error('MASTRA_DATABASE_URL must use an absolute file URL.');
  }

  const protocol = new URL(databaseUrl).protocol;

  if (!['file:', 'libsql:', 'https:'].includes(protocol)) {
    throw new Error('MASTRA_DATABASE_URL must use file, libsql, or HTTPS.');
  }

  return databaseUrl;
}

export function resolveRuntimeConfig({
  dataDir = process.env.MASTRA_DATA_DIR ?? path.join(process.cwd(), '.mastra', 'career-copilot'),
  databaseUrl = process.env.MASTRA_DATABASE_URL,
}: RuntimeConfigInput = {}) {
  const absoluteDataDir = path.resolve(dataDir);
  fs.mkdirSync(absoluteDataDir, { recursive: true });

  return {
    dataDir: absoluteDataDir,
    workspacePath: path.join(absoluteDataDir, 'workspace'),
    databaseUrl: assertPersistentDatabaseUrl(
      databaseUrl ?? `file:${path.join(absoluteDataDir, 'mastra.db')}`,
    ),
  };
}
