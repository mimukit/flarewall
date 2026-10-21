// The flarewall command line. Phase 4 adds apply and restore.
import { parseArgs } from 'node:util';
import type { CloudflareApi } from '../core/api.js';
import type { Change, ForeignRule } from '../core/diff.js';
import { exitCode, statusAll, type ZoneReport } from '../core/status.js';
import { addZone, DataError, initBaseline, loadData, resolveDataDir } from '../node/data.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Builds the CloudflareApi from the token. Tests pass a factory that returns a fake. */
export type ApiFactory = (token: string) => CloudflareApi | Promise<CloudflareApi>;

export interface RunDeps {
  api?: ApiFactory;
}

const defaultApi: ApiFactory = async (token) => {
  const { createSdkClient } = await import('../node/sdk-client.js');
  return createSdkClient(token);
};

const USAGE = `Usage: flarewall <command> [options]

Commands:
  init              Copy the default baseline to <data>/baseline.yaml
  add <zone>        Write inventory/<account-id>/<zone>.yaml for a zone with no entry
  status [zone...]  Print one row per zone: name, plan, state
  diff [zone...]    Print the changes per zone

Options:
  --data <path>   The private data repo (default: $FLAREWALL_DATA)
  -h, --help      Show this help

Environment:
  CLOUDFLARE_API_TOKEN  The Cloudflare API token (add, status, diff)

Exit codes (status, diff): 0 in sync, 1 drift or legacy, 2 error`;

const TOKEN_MISSING = 'CLOUDFLARE_API_TOKEN is not set; flarewall reads the Cloudflare token from this variable only';

function columns(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ').trimEnd());
}

function statusLines(reports: readonly ZoneReport[]): string[] {
  const rows = [['ZONE', 'PLAN', 'STATE']];
  for (const r of reports) rows.push([r.zone, r.plan || '-', r.state === 'error' ? `error: ${r.error ?? ''}` : r.state]);
  return columns(rows);
}

function show(value: unknown): string {
  return value === undefined ? '(none)' : JSON.stringify(value);
}

function changeLine(c: Change): string {
  switch (c.kind) {
    case 'missing':
      return `${c.phase}: missing ${c.ref} "${c.description}"`;
    case 'extra':
      return `${c.phase}: extra ${c.ref} "${c.description}"`;
    case 'changed':
      return `${c.phase}: changed ${c.ref} "${c.description}" (${c.fields.join(', ')})`;
    case 'order':
      return `${c.phase}: order is ${c.actual.join(', ')}; want ${c.expected.join(', ')}`;
    case 'setting':
      return `setting ${c.setting}: live ${show(c.actual)}; want ${show(c.expected)}`;
    case 'bot_management':
      return `bot management: live ${show(c.actual)}; want ${show(c.expected)}`;
  }
}

function foreignLine(kind: string, r: ForeignRule): string {
  const name = [r.ref, r.description === undefined ? undefined : `"${r.description}"`].filter(Boolean).join(' ') || '(no ref or description)';
  return `${r.phase}: ${kind} ${name}${r.id ? ` (id ${r.id})` : ''}`;
}

function diffLines(reports: readonly ZoneReport[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    if (r.state === 'error') {
      lines.push(`${r.zone}: error: ${r.error ?? ''}`);
      continue;
    }
    if (r.state === 'not managed') {
      lines.push(`${r.zone}: not managed (no inventory entry; run flarewall add ${r.zone})`);
      continue;
    }
    lines.push(`${r.zone}: ${r.state}`);
    const diff = r.diff;
    if (diff === undefined) continue;
    for (const l of diff.legacy) lines.push(`  ${foreignLine('legacy', l)}`);
    for (const c of diff.changes) lines.push(`  ${changeLine(c)}`);
    for (const u of diff.unowned) lines.push(`  ${foreignLine('unowned', u)}`);
  }
  return lines;
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
