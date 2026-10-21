// Node-only adapter for the private data repo on disk.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CloudflareApi } from '../core/api.js';
import { parseBaseline, parseInventory, type Baseline, type Inventory } from '../core/schema.js';

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

export function inventoryDir(dataDir: string): string {
  return join(dataDir, 'inventory');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Reads and validates one YAML file, turning a missing file or a schema error into a DataError. */
async function readYaml<T>(path: string, parse: (text: string) => T, missingHint: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new DataError(`${path} not found${missingHint}`);
    throw error;
  }
  try {
    return parse(text);
  } catch (error) {
    // A schema error or a YAML syntax error: either way the message names the file.
    if (error instanceof Error) throw new DataError(`${path}: ${error.message}`);
    throw error;
  }
}

export interface DataSet {
  baseline: Baseline;
  inventories: Inventory[];
}

/**
 * Reads <data>/baseline.yaml and every .yaml file under inventory/. A missing inventory directory
 * means no zones. Throws DataError on a missing baseline, a bad file, or a zone listed twice.
 */
export async function loadData(dataDir: string): Promise<DataSet> {
  const baseline = await readYaml(baselinePath(dataDir), parseBaseline, '; run flarewall init first');
  let files: string[] = [];
  try {
    files = (await readdir(inventoryDir(dataDir), { recursive: true }))
      .filter((f) => f.endsWith('.yaml'))
      .sort();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const inventories: Inventory[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const path = join(inventoryDir(dataDir), file);
    const inventory = await readYaml(path, parseInventory, '');
    for (const key of [inventory.zone, inventory.zone_id]) {
      const other = seen.get(key);
      if (other !== undefined) throw new DataError(`${path}: zone ${inventory.zone} is also listed in ${other}`);
      seen.set(key, path);
    }
    inventories.push(inventory);
  }
  return { baseline, inventories };
}

/** The text of a new inventory file. The proxied hostnames go in as comments for the owner to sort. */
export function newInventoryText(zone: string, zoneId: string, proxiedHosts: readonly string[]): string {
  const lines = [
    `# Inventory for ${zone}, written by flarewall add.`,
    '# Put each host below in hosts.api or hosts.wordpress where it fits, then check redirects.',
    '# Proxied hostnames in this zone:',
    ...(proxiedHosts.length > 0 ? proxiedHosts.map((h) => `#   ${h}`) : ['#   (none)']),
    'version: 1',
    `zone: ${zone}`,
    `zone_id: "${zoneId}"`,
    'hosts:',
    '  api: []',
    '  wordpress: []',
    'redirects: root',
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes inventory/<account-id>/<zone>.yaml for a zone the token can see, and returns its path.
 * Refuses when the zone is not visible or the file exists.
 */
export async function addZone(api: CloudflareApi, dataDir: string, zoneName: string): Promise<string> {
  const zone = (await api.listZones()).find((z) => z.name === zoneName);
  if (zone === undefined) throw new DataError(`zone ${zoneName} not found: the token cannot see it`);
  if (zone.accountId === '' || /[\\/]|\.\./.test(zone.accountId) || /[\\/]|\.\./.test(zone.name)) {
    throw new DataError(`zone ${zoneName}: unexpected zone name or account id from the API`);
  }
  const records = await api.listDnsRecords(zone.id);
  const hosts = [...new Set(records.filter((r) => r.proxied).map((r) => r.name))].sort();
  const path = join(inventoryDir(dataDir), zone.accountId, `${zone.name}.yaml`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, newInventoryText(zone.name, zone.id, hosts), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DataError(`${path} already exists; flarewall add does not overwrite it`);
    }
    throw error;
  }
  return path;
}
