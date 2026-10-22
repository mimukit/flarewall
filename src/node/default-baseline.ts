// Node-only: the default baseline shipped with the package (src/baseline or dist/baseline).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASELINE_PATH = fileURLToPath(new URL('../baseline/default.yaml', import.meta.url));

export async function readDefaultBaseline(): Promise<string> {
  return readFile(DEFAULT_BASELINE_PATH, 'utf8');
}
