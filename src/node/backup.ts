// Node-only adapter: writes and reads zone backups under <data>/backups/<zone>/<UTC time>/.
// The tool never runs git; the owner commits the backups.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BotManagementState, LiveRule, SettingId } from '../core/api.js';
import { BACKUP_SETTINGS, type BackupWriter, type ZoneBackup } from '../core/apply.js';
import { PHASES } from '../core/render.js';
import { DataError } from './data.js';

const BOT_FILE = 'bot_management.json';

/** A UTC time as a directory name, such as 20261021T081500Z. */
export function backupStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function backupRoot(dataDir: string, zone: string): string {
  return join(dataDir, 'backups', zone);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Creates a new directory; a second backup in the same second gets a -1, -2, ... suffix. */
async function freshDir(base: string): Promise<string> {
  for (let i = 0; ; i++) {
    const dir = i === 0 ? base : `${base}-${i}`;
    try {
      await mkdir(dir);
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** A BackupWriter that writes one JSON file per phase, per setting, and for Bot Fight Mode. */
export function createBackupWriter(dataDir: string, now: () => Date = () => new Date()): BackupWriter {
  return async (zone, backup) => {
    if (/[\\/]|\.\./.test(zone)) throw new DataError(`zone ${zone}: unexpected zone name for a backup path`);
    await mkdir(backupRoot(dataDir, zone), { recursive: true });
    const dir = await freshDir(join(backupRoot(dataDir, zone), backupStamp(now())));
    for (const phase of PHASES) {
      const rules = backup.phases[phase];
      if (rules !== undefined) await writeFile(join(dir, `${phase}.json`), json(rules), { flag: 'wx' });
    }
    for (const id of BACKUP_SETTINGS) {
      if (id in backup.settings) await writeFile(join(dir, `${id}.json`), json({ value: backup.settings[id] ?? null }), { flag: 'wx' });
    }
    if (backup.botManagement !== undefined) await writeFile(join(dir, BOT_FILE), json(backup.botManagement), { flag: 'wx' });
    return dir;
  };
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DataError(`${path}: not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * The backup directory for `restore <zone> <dir>`: the path as given when it exists, else
 * <data>/backups/<zone>/<dir>.
 */
export async function resolveBackupDir(dataDir: string | undefined, zone: string, dir: string): Promise<string> {
  const candidates = [resolve(dir)];
  if (dataDir !== undefined) candidates.push(join(backupRoot(dataDir, zone), dir));
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new DataError(`backup ${dir} not found (looked in ${candidates.join(' and ')})`);
}

/** Reads a backup directory written by createBackupWriter. Files that are absent stay absent. */
export async function readBackup(dir: string): Promise<ZoneBackup> {
  const backup: ZoneBackup = { phases: {}, settings: {} };
  for (const phase of PHASES) {
    const path = join(dir, `${phase}.json`);
    const rules = await readJson(path);
    if (rules === undefined) continue;
    if (!Array.isArray(rules)) throw new DataError(`${path}: expected a JSON array of rules`);
    backup.phases[phase] = rules as LiveRule[];
  }
  for (const id of BACKUP_SETTINGS) {
    const path = join(dir, `${id}.json`);
    const setting = (await readJson(path)) as { value?: unknown } | undefined;
    if (setting === undefined) continue;
    if (setting === null || typeof setting !== 'object' || !('value' in setting)) throw new DataError(`${path}: expected {"value": ...}`);
    if (setting.value !== null) backup.settings[id as SettingId] = setting.value;
  }
  const bot = await readJson(join(dir, BOT_FILE));
  if (bot !== undefined) backup.botManagement = bot as BotManagementState;
  if (Object.keys(backup.phases).length === 0 && Object.keys(backup.settings).length === 0 && backup.botManagement === undefined) {
    throw new DataError(`${dir}: holds no backup files`);
  }
  return backup;
}
