// The core must run in a Worker later, so it may not use a Node-only API.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE = fileURLToPath(new URL('../src/core/', import.meta.url));
const FORBIDDEN = [/from ['"]node:/, /from ['"](fs|path|os|url|util|child_process)['"]/, /\bprocess\./, /\bBuffer\b/, /\brequire\(/];

describe('core purity', () => {
  it.each(readdirSync(CORE).filter((f) => f.endsWith('.ts')))('%s uses no Node-only API', (file) => {
    const text = readFileSync(CORE + file, 'utf8');
    for (const pattern of FORBIDDEN) expect(text, String(pattern)).not.toMatch(pattern);
  });
});
