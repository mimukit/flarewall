// The flarewall command line: init, add, status, diff, apply, restore.
import { parseArgs } from 'node:util';
import type { CloudflareApi } from '../core/api.js';
import { applyInventoryZone, restoreZone, type BackupWriter } from '../core/apply.js';
import type { Inventory } from '../core/schema.js';
import { exitCode, statusAll } from '../core/status.js';
import { createBackupWriter, readBackup, resolveBackupDir } from '../node/backup.js';
import { addZone, DataError, initBaseline, loadData, resolveDataDir } from '../node/data.js';
import { applyOutcomeText, diffLines, planLines, restoreLines, restoreOutcomeText, statusLines } from './format.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Builds the CloudflareApi from the token. Tests pass a factory that returns a fake. */
export type ApiFactory = (token: string) => CloudflareApi | Promise<CloudflareApi>;

/** Asks a yes or no question; true means yes. */
export type Confirm = (question: string) => Promise<boolean>;

export interface RunDeps {
  api?: ApiFactory;
  /** The per-zone prompt. Default: a readline question on stdin. */
  confirm?: Confirm;
  /** Whether stdin is a terminal. Default: process.stdin.isTTY. */
  isTTY?: boolean;
  /** The clock for backup directory names. */
  now?: () => Date;
}

const defaultApi: ApiFactory = async (token) => {
  const { createSdkClient } = await import('../node/sdk-client.js');
  return createSdkClient(token);
};

const defaultConfirm: Confirm = async (question) => {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
};

const USAGE = `Usage: flarewall <command> [options]

Commands:
  init              Copy the default baseline to <data>/baseline.yaml
  add <zone>        Write inventory/<account-id>/<zone>.yaml for a zone with no entry
  status [zone...]  Print one row per zone: name, plan, state
  diff [zone...]    Print the changes per zone
  apply <zone...|--all>     Send the baseline to the zones (dry run without --write)
  restore <zone> <backup>   Send a backup directory back to a zone (dry run without --write)

Options:
  --data <path>   The private data repo (default: $FLAREWALL_DATA)
  --all           apply: every inventory zone
  --write         apply, restore: send the writes (back up first, ask per zone, read back)
  --yes           apply, restore: do not ask per zone
  -h, --help      Show this help

Environment:
  CLOUDFLARE_API_TOKEN  The Cloudflare API token (add, status, diff, apply, restore)

Exit codes (status, diff): 0 in sync, 1 drift or legacy, 2 error
Exit codes (apply, restore): 0 every zone done or declined, 2 any zone failed or a usage error`;

const TOKEN_MISSING = 'CLOUDFLARE_API_TOKEN is not set; flarewall reads the Cloudflare token from this variable only';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one CLI invocation and returns the exit code. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
  deps: RunDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        data: { type: 'string' },
        all: { type: 'boolean' },
        write: { type: 'boolean' },
        yes: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help) {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }

  const connect = async (): Promise<CloudflareApi | undefined> => {
    const token = env.CLOUDFLARE_API_TOKEN;
    if (token === undefined || token === '') {
      io.err(TOKEN_MISSING);
      return undefined;
    }
    return (deps.api ?? defaultApi)(token);
  };

  const write = parsed.values.write === true;
  const yes = parsed.values.yes === true;
  /** Refuses a write that nobody can confirm. */
  const writeRefused = (): boolean => {
    if (write && !yes && !(deps.isTTY ?? process.stdin.isTTY === true)) {
      io.err('refusing to write: stdin is not a terminal, so flarewall cannot ask per zone; pass --yes to write without asking');
      return true;
    }
    return false;
  };
  const writeOptions = (dataDir: string, verb: string) => {
    const writer = createBackupWriter(dataDir, deps.now);
    const backup: BackupWriter = async (zone, state) => {
      const path = await writer(zone, state);
      io.out(`${zone}: backup written to ${path}`);
      return path;
    };
    const ask = deps.confirm ?? defaultConfirm;
    return { write, backup, ...(yes ? {} : { confirm: (zone: string) => ask(`${verb} ${zone}? [y/N] `) }) };
  };

  try {
    switch (command) {
      case 'init': {
        if (rest.length > 0) {
          io.err(`init takes no arguments, got: ${rest.join(' ')}`);
          return 2;
        }
        const path = await initBaseline(resolveDataDir(parsed.values.data, env));
        io.out(`Wrote ${path}`);
        return 0;
      }
      case 'add': {
        if (rest.length !== 1 || rest[0] === undefined) {
          io.err('add takes exactly one zone name');
          return 2;
        }
        const dataDir = resolveDataDir(parsed.values.data, env);
        const api = await connect();
        if (api === undefined) return 2;
        const path = await addZone(api, dataDir, rest[0]);
        io.out(`Wrote ${path}`);
        return 0;
      }
      case 'status':
      case 'diff': {
        const api = await connect();
        if (api === undefined) return 2;
        const { baseline, inventories } = await loadData(resolveDataDir(parsed.values.data, env));
        const reports = await statusAll(api, baseline, inventories, rest);
        for (const line of command === 'status' ? statusLines(reports) : diffLines(reports)) io.out(line);
        return exitCode(reports);
      }
      case 'apply': {
        const all = parsed.values.all === true;
        if (all === rest.length > 0) {
          io.err(all ? 'apply takes zone names or --all, not both' : 'apply needs zone names or --all');
          return 2;
        }
        if (writeRefused()) return 2;
        const dataDir = resolveDataDir(parsed.values.data, env);
        const api = await connect();
        if (api === undefined) return 2;
        const { baseline, inventories } = await loadData(dataDir);
        const options = writeOptions(dataDir, 'Apply the baseline to');
        let failed = false;
        for (const name of all ? inventories.map((i) => i.zone) : rest) {
          const inventory: Inventory | undefined = inventories.find((i) => i.zone === name);
          if (inventory === undefined) {
            io.err(`${name}: error: no inventory entry; run flarewall add ${name}`);
            failed = true;
            continue;
          }
          try {
            const result = await applyInventoryZone(api, baseline, inventory, {
              ...options,
              onPlan: (plan) => {
                for (const line of planLines(plan)) io.out(line);
              },
            });
            io.out(`${name}: ${applyOutcomeText(result.outcome)}`);
          } catch (error) {
            io.err(`${name}: error: ${message(error)}`);
            failed = true;
          }
        }
        return failed ? 2 : 0;
      }
      case 'restore': {
        const [name, dirArg] = rest;
        if (rest.length !== 2 || name === undefined || dirArg === undefined) {
          io.err('restore takes a zone name and a backup directory');
          return 2;
        }
        if (writeRefused()) return 2;
        const dataDir = resolveDataDir(parsed.values.data, env);
        const dir = await resolveBackupDir(dataDir, name, dirArg);
        const backup = await readBackup(dir);
        const api = await connect();
        if (api === undefined) return 2;
        const { inventories } = await loadData(dataDir);
        const zoneId = inventories.find((i) => i.zone === name)?.zone_id ?? (await api.listZones()).find((z) => z.name === name)?.id;
        if (zoneId === undefined) {
          io.err(`${name}: error: no inventory entry, and the token cannot see this zone`);
          return 2;
        }
        try {
          const result = await restoreZone(api, { name, id: zoneId }, backup, {
            ...writeOptions(dataDir, 'Restore'),
            onPlan: (plan) => {
              for (const line of restoreLines(plan, dir)) io.out(line);
            },
          });
          io.out(`${name}: ${restoreOutcomeText(result.outcome)}`);
          return 0;
        } catch (error) {
          io.err(`${name}: error: ${message(error)}`);
          return 2;
        }
      }
      default:
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof DataError) {
      io.err(error.message);
      return 2;
    }
    io.err(`error: ${(error as Error).message ?? String(error)}`);
    return 2;
  }
}
