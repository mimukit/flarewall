// The flarewall command line: the zone commands (init, add, status, diff, apply, restore, tui) and
// the revision commands (edit, propose, log, show, revert, approve, reject, backups, export, import).
import { parseArgs } from 'node:util';
import type { CloudflareApi } from '../core/api.js';
import { applyInventoryZone, restoreZone, type BackupWriter } from '../core/apply.js';
import {
  addZoneInventory,
  DataError,
  loadDataSet,
  parseBackup,
  parseDoc,
  proposeRevision,
  revertTo,
  runZones,
  saveOwnerRevision,
  storeBackupWriter,
  textDiff,
  type Saved,
} from '../core/revisions.js';
import type { Inventory } from '../core/schema.js';
import { exitCode, statusAll } from '../core/status.js';
import { docName, exportText, parseExport, StoreError, type DataStore, type DocRef, type Revision } from '../core/store.js';
import type { Editor } from '../node/edit.js';
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
  /** The data store. Default: the SQLite file at FLAREWALL_DB. Tests pass an in-memory store, which run does not close. */
  store?: DataStore;
  /** The per-zone prompt. Default: a readline question on stdin. */
  confirm?: Confirm;
  /** Whether stdin is a terminal. Default: process.stdin.isTTY. */
  isTTY?: boolean;
  /** The clock for every stored timestamp. */
  now?: () => Date;
  /** The editor for `edit`. Default: $VISUAL or $EDITOR. */
  editor?: Editor;
  /** Reads all of stdin, for `propose ... -`. */
  readStdin?: () => Promise<string>;
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

const defaultReadStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const USAGE = `Usage: flarewall <command> [options]

Zone commands:
  init              Create the database and write the default baseline as its first revision
  add <zone>        Write the first inventory revision for a zone the token can see
  status [zone...]  Print one row per zone: name, plan, state
  diff [zone...]    Print the changes per zone, and record the run (skip with --no-record)
  apply <zone...|--all>         Send the baseline to the zones (dry run without --write)
  restore <zone> <backup-id>    Send a stored backup back to a zone (dry run without --write)
  backups <zone>    List the stored backups of a zone
  tui               Open the terminal UI: every zone's state and diff on one screen

Revision commands:
  edit <zone> | edit --baseline       Edit the current text in $EDITOR and save a new revision
  propose <zone> <file|-> | propose --baseline <file|->
                    Write a pending revision for the owner to approve, and print its id
  log [zone]        List the revisions, oldest first
  show <id>         Print one revision: a comment header, then the YAML text
  revert <id>       Save the text of an older approved revision as a new revision
  approve <id>      Approve a pending revision
  reject <id>       Reject a pending revision
  export <file>     Write every table to one JSON file
  import <file>     Load an export file into an empty database

Options:
  --all             apply: every inventory zone
  --write           apply, restore: send the writes (back up first, ask per zone, read back)
  --yes             apply, restore: do not ask per zone
  --no-record       diff: do not record the run
  --baseline        edit, propose: the baseline in place of a zone inventory
  -m, --message <text>  edit, propose, revert: the revision message
  --author <word>   propose: the author word (default: skill)
  -h, --help        Show this help

Environment:
  FLAREWALL_DB          The database file (default: $XDG_DATA_HOME/flarewall/flarewall.sqlite,
                        or ~/.local/share/flarewall/flarewall.sqlite)
  CLOUDFLARE_API_TOKEN  The Cloudflare API token (add, status, diff, apply, restore, tui)
  EDITOR                The editor for edit (VISUAL first, vi when neither is set)

Exit codes (status, diff): 0 in sync, 1 drift or legacy, 2 error
Exit codes (other commands): 0 done or declined, 2 any failure or a usage error`;

const TOKEN_MISSING = 'CLOUDFLARE_API_TOKEN is not set; flarewall reads the Cloudflare token from this variable only';
const DATA_GONE = '--data is gone; flarewall reads FLAREWALL_DB';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A revision id argument: a positive integer, with or without a leading `#`. */
function revisionId(arg: string | undefined): number | undefined {
  const match = /^#?([1-9]\d*)$/.exec(arg ?? '');
  return match === null ? undefined : Number(match[1]);
}

function revisionDoc(revision: Revision): string {
  return revision.kind === 'baseline' ? 'baseline' : `${revision.zone} inventory`;
}

/** One `log` line: id, time, document, status, author, message. */
function logLine(r: Revision): string {
  return [`#${r.id}`, r.createdAt, revisionDoc(r), r.status, r.author, r.message ?? ''].join('  ').trimEnd();
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
        // Only to say that it is gone.
        data: { type: 'string' },
        all: { type: 'boolean' },
        write: { type: 'boolean' },
        yes: { type: 'boolean' },
        'no-record': { type: 'boolean' },
        baseline: { type: 'boolean' },
        message: { type: 'string', short: 'm' },
        author: { type: 'string' },
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
  if (parsed.values.data !== undefined || (env.FLAREWALL_DATA !== undefined && env.FLAREWALL_DATA !== '')) {
    io.err(DATA_GONE);
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

  /** The stores this invocation opened, closed at the end. A store from deps stays open. */
  const opened: DataStore[] = [];
  const openStore = async (create = false): Promise<DataStore> => {
    if (deps.store !== undefined) return deps.store;
    // A dynamic import, so node:sqlite loads only after main.ts filters its warning.
    const { openSqliteStore, resolveDbPath } = await import('../node/sqlite-store.js');
    const store = openSqliteStore(resolveDbPath(env), { create, ...(deps.now === undefined ? {} : { now: deps.now }) });
    opened.push(store);
    return store;
  };

  const write = parsed.values.write === true;
  const yes = parsed.values.yes === true;
  const msg = parsed.values.message;
  /** Refuses a write that nobody can confirm. */
  const writeRefused = (): boolean => {
    if (write && !yes && !(deps.isTTY ?? process.stdin.isTTY === true)) {
      io.err('refusing to write: stdin is not a terminal, so flarewall cannot ask per zone; pass --yes to write without asking');
      return true;
    }
    return false;
  };
  const writeOptions = (store: DataStore, verb: string) => {
    const writer = storeBackupWriter(store);
    const backup: BackupWriter = async (zone, state) => {
      const name = await writer(zone, state);
      io.out(`${zone.name}: ${name} saved`);
      return name;
    };
    const ask = deps.confirm ?? defaultConfirm;
    return { write, backup, ...(yes ? {} : { confirm: (zone: string) => ask(`${verb} ${zone}? [y/N] `) }) };
  };
  /** The document named by `<zone>` or `--baseline`, from the first positional. */
  const docArg = (args: string[], extra: number): DocRef | undefined => {
    if (parsed.values.baseline === true) {
      if (args.length !== extra) return undefined;
      return { kind: 'baseline', zone: null };
    }
    if (args.length !== extra + 1 || args[0] === undefined) return undefined;
    return { kind: 'inventory', zone: args[0] };
  };
  const printSaved = (saved: Saved) => {
    io.out(`saved ${revisionDoc(saved.revision)} revision ${saved.revision.id}`);
    if (saved.stale.length > 0) {
      io.out(`pending revisions now stale (approval will refuse them): ${saved.stale.map((id) => `#${id}`).join(', ')}`);
    }
  };

  try {
    switch (command) {
      case 'init': {
        if (rest.length > 0) {
          io.err(`init takes no arguments, got: ${rest.join(' ')}`);
          return 2;
        }
        const store = await openStore(true);
        const baseline: DocRef = { kind: 'baseline', zone: null };
        if ((await store.current(baseline)) !== undefined) {
          io.err(`the database at ${store.location} already holds a baseline; flarewall init does not overwrite it`);
          return 2;
        }
        const { readDefaultBaseline } = await import('../node/default-baseline.js');
        const revision = await store.addRevision({ ...baseline, status: 'approved', text: await readDefaultBaseline(), author: 'owner', message: 'flarewall init' });
        io.out(`baseline revision ${revision.id} written to ${store.location}`);
        return 0;
      }
      case 'add': {
        if (rest.length !== 1 || rest[0] === undefined) {
          io.err('add takes exactly one zone name');
          return 2;
        }
        const store = await openStore();
        const api = await connect();
        if (api === undefined) return 2;
        const revision = await addZoneInventory(api, store, rest[0]);
        io.out(`saved ${revisionDoc(revision)} revision ${revision.id}; sort its hosts with flarewall edit ${rest[0]}`);
        return 0;
      }
      case 'status':
      case 'diff': {
        const store = await openStore();
        const api = await connect();
        if (api === undefined) return 2;
        const { baseline, inventories } = await loadDataSet(store);
        const reports = await statusAll(api, baseline, inventories, rest);
        for (const line of command === 'status' ? statusLines(reports) : diffLines(reports)) io.out(line);
        if (command === 'diff' && parsed.values['no-record'] !== true) await store.addRun(runZones(reports));
        return exitCode(reports);
      }
      case 'apply': {
        const all = parsed.values.all === true;
        if (all === rest.length > 0) {
          io.err(all ? 'apply takes zone names or --all, not both' : 'apply needs zone names or --all');
          return 2;
        }
        if (writeRefused()) return 2;
        const store = await openStore();
        const api = await connect();
        if (api === undefined) return 2;
        const { baseline, inventories } = await loadDataSet(store);
        const options = writeOptions(store, 'Apply the baseline to');
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
        const [name] = rest;
        const id = revisionId(rest[1]);
        if (rest.length !== 2 || name === undefined || id === undefined) {
          io.err('restore takes a zone name and a backup id');
          return 2;
        }
        if (writeRefused()) return 2;
        const store = await openStore();
        const row = await store.getBackup(id);
        if (row === undefined || row.zone !== name) {
          io.err(`${name}: error: no backup ${id} for this zone; list them with flarewall backups ${name}`);
          return 2;
        }
        const backup = parseBackup(id, row.backup);
        const api = await connect();
        if (api === undefined) return 2;
        const current = await store.current({ kind: 'inventory', zone: name });
        const zoneId = (current === undefined ? undefined : (parseDoc(current, current.text) as Inventory).zone_id) ?? (await api.listZones()).find((z) => z.name === name)?.id;
        if (zoneId === undefined) {
          io.err(`${name}: error: no inventory entry, and the token cannot see this zone`);
          return 2;
        }
        try {
          const result = await restoreZone(api, { name, id: zoneId }, backup, {
            ...writeOptions(store, 'Restore'),
            onPlan: (plan) => {
              for (const line of restoreLines(plan, `backup ${id} (${row.createdAt})`)) io.out(line);
            },
          });
          io.out(`${name}: ${restoreOutcomeText(result.outcome)}`);
          return 0;
        } catch (error) {
          io.err(`${name}: error: ${message(error)}`);
          return 2;
        }
      }
      case 'backups': {
        if (rest.length !== 1 || rest[0] === undefined) {
          io.err('backups takes exactly one zone name');
          return 2;
        }
        const rows = await (await openStore()).listBackups(rest[0]);
        if (rows.length === 0) io.out(`${rest[0]}: no backups`);
        for (const row of rows) io.out(`#${row.id}  ${row.createdAt}  ${row.zone}  zone ${row.zoneId}`);
        return 0;
      }
      case 'edit': {
        const doc = docArg(rest, 0);
        if (doc === undefined) {
          io.err('edit takes one zone name, or --baseline');
          return 2;
        }
        const store = await openStore();
        const current = await store.current(doc);
        if (current === undefined) {
          io.err(doc.kind === 'baseline' ? 'no baseline yet; run flarewall init first' : `run flarewall add ${doc.zone} first`);
          return 2;
        }
        const { editText, shellEditor } = await import('../node/edit.js');
        const edited = await editText(current.text, (text) => void parseDoc(doc, text), deps.editor ?? shellEditor(env));
        if (edited === undefined) {
          io.out(`${docName(doc)}: the file was emptied; nothing saved`);
          return 0;
        }
        if (edited === current.text) {
          io.out(`${docName(doc)}: no change; nothing saved`);
          return 0;
        }
        for (const line of textDiff(current.text, edited)) io.out(line);
        printSaved(await saveOwnerRevision(store, doc, edited, msg));
        return 0;
      }
      case 'propose': {
        const doc = docArg(rest, 1);
        const file = rest.at(-1);
        if (doc === undefined || file === undefined) {
          io.err('propose takes a zone name and a file, or --baseline and a file; the file can be - for stdin');
          return 2;
        }
        const store = await openStore();
        let text: string;
        if (file === '-') {
          text = await (deps.readStdin ?? defaultReadStdin)();
        } else {
          const { readFile } = await import('node:fs/promises');
          text = await readFile(file, 'utf8');
        }
        const revision = await proposeRevision(store, doc, text, parsed.values.author ?? 'skill', msg);
        io.out(`pending revision ${revision.id}`);
        return 0;
      }
      case 'log': {
        if (rest.length > 1) {
          io.err('log takes at most one zone name');
          return 2;
        }
        const revisions = await (await openStore()).listRevisions(rest[0] === undefined ? {} : { zone: rest[0] });
        if (revisions.length === 0) io.out('no revisions');
        for (const r of revisions) io.out(logLine(r));
        return 0;
      }
      case 'show': {
        const id = revisionId(rest[0]);
        if (rest.length !== 1 || id === undefined) {
          io.err('show takes one revision id');
          return 2;
        }
        const r = await (await openStore()).getRevision(id);
        if (r === undefined) {
          io.err(`no revision ${id}`);
          return 2;
        }
        io.out(`# revision ${r.id}: ${revisionDoc(r)}, ${r.status}, by ${r.author}, ${r.createdAt}`);
        io.out(`# parent ${r.parentId === null ? 'none' : `#${r.parentId}`}, sha256 ${r.sha256}`);
        if (r.message !== null) io.out(`# message: ${r.message}`);
        io.out(r.text.replace(/\n$/, ''));
        return 0;
      }
      case 'revert': {
        const id = revisionId(rest[0]);
        if (rest.length !== 1 || id === undefined) {
          io.err('revert takes one revision id');
          return 2;
        }
        printSaved(await revertTo(await openStore(), id, msg));
        return 0;
      }
      case 'approve':
      case 'reject': {
        const id = revisionId(rest[0]);
        if (rest.length !== 1 || id === undefined) {
          io.err(`${command} takes one revision id`);
          return 2;
        }
        const r = await (await openStore()).decide(id, command === 'approve' ? 'approved' : 'rejected');
        io.out(`${r.status} revision ${r.id} (${revisionDoc(r)})`);
        return 0;
      }
      case 'export': {
        if (rest.length !== 1 || rest[0] === undefined) {
          io.err('export takes one file name');
          return 2;
        }
        const store = await openStore();
        const { writeFile } = await import('node:fs/promises');
        try {
          await writeFile(rest[0], exportText(await store.exportData()), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DataError(`${rest[0]} already exists; flarewall export does not overwrite it`);
          throw error;
        }
        io.out(`exported ${store.location} to ${rest[0]}`);
        return 0;
      }
      case 'import': {
        if (rest.length !== 1 || rest[0] === undefined) {
          io.err('import takes one file name');
          return 2;
        }
        const { readFile } = await import('node:fs/promises');
        const data = parseExport(await readFile(rest[0], 'utf8'));
        const store = await openStore(true);
        await store.importData(data);
        io.out(`imported ${data.revisions.length} revisions, ${data.backups.length} backups, and ${data.runs.length} runs into ${store.location}`);
        return 0;
      }
      case 'tui': {
        if (rest.length > 0) {
          io.err(`tui takes no arguments, got: ${rest.join(' ')}`);
          return 2;
        }
        if (!(deps.isTTY ?? process.stdin.isTTY === true)) {
          io.err('refusing to start the tui: stdin is not a terminal');
          return 2;
        }
        const store = await openStore();
        const api = await connect();
        if (api === undefined) return 2;
        // A dynamic import, so no other command loads Ink or React.
        const { startTui } = await import('../tui/main.js');
        return await startTui({ api, store });
      }
      default:
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof DataError || error instanceof StoreError) {
      io.err(error.message);
      return 2;
    }
    io.err(`error: ${(error as Error).message ?? String(error)}`);
    return 2;
  } finally {
    for (const store of opened) store.close();
  }
}
