// Node-only adapter for the private data repo on disk.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path of the default baseline shipped with the package (src/baseline or dist/baseline). */
export const DEFAULT_BASELINE_PATH = fileURLToPath(new URL('../baseline/default.yaml', import.meta.url));

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataError';
  }
}

/** The data repo path: the `--data` flag first, then FLAREWALL_DATA. */
export function resolveDataDir(flag: string | undefined, env: Record<string, string | undefined>): string {
  const dir = flag ?? env.FLAREWALL_DATA;
  if (dir === undefined || dir === '') {
    throw new DataError('no data path: pass --data <path> or set FLAREWALL_DATA');
  }
  return dir;
}

export function baselinePath(dataDir: string): string {
  return join(dataDir, 'baseline.yaml');
}

export async function readDefaultBaseline(): Promise<string> {
  return readFile(DEFAULT_BASELINE_PATH, 'utf8');
}

/**
 * Copies the default baseline to <dataDir>/baseline.yaml and returns that path.
 * Creates dataDir when it is missing. Refuses to overwrite an existing baseline.
 */
export async function initBaseline(dataDir: string): Promise<string> {
  const target = baselinePath(dataDir);
  const text = await readDefaultBaseline();
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(target, text, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DataError(`${target} already exists; flarewall init does not overwrite it`);
    }
    throw error;
  }
  return target;
}
