#!/usr/bin/env node
import { quietSqliteWarning } from '../node/warnings.js';
import { run } from './run.js';

// Before run loads node:sqlite, so Node 22's ExperimentalWarning never reaches stderr.
quietSqliteWarning();
const code = await run(process.argv.slice(2), process.env, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
