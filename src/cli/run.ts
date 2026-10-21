// The flarewall command line. Phase 3 and 4 add status, diff, add, apply, and restore.
import { parseArgs } from 'node:util';
import { DataError, initBaseline, resolveDataDir } from '../node/data.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: flarewall <command> [options]

Commands:
  init      Copy the default baseline to <data>/baseline.yaml

Options:
  --data <path>   The private data repo (default: $FLAREWALL_DATA)
  -h, --help      Show this help`;

/** Runs one CLI invocation and returns the exit code. */
export async function run(argv: string[], env: Record<string, string | undefined>, io: Io): Promise<number> {
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
      default:
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof DataError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
