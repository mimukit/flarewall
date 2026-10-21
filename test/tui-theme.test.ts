// The TUI colours: the line colour rules match the text the shared CLI formatters print.
import { describe, expect, it } from 'vitest';
import { changeLine, foreignLine, stepLine } from '../src/cli/format.js';
import { lineColor, MOCHA, STATE_COLOR } from '../src/tui/theme.js';

describe('TUI theme', () => {
  it('gives each state its Catppuccin Mocha colour', () => {
    expect(STATE_COLOR).toMatchObject({ 'in sync': MOCHA.green, drift: MOCHA.yellow, legacy: MOCHA.pink, error: MOCHA.red, 'not managed': MOCHA.subtext0 });
  });

  it('colours the diff lines by kind', () => {
    const phase = 'http_request_firewall_custom' as const;
    expect(lineColor(`  ${changeLine({ kind: 'missing', phase, ref: 'flarewall_a', description: 'a' })}`)).toBe(MOCHA.green);
    expect(lineColor(`  ${changeLine({ kind: 'extra', phase, ref: 'flarewall_a', description: 'a' })}`)).toBe(MOCHA.red);
    expect(lineColor(`  ${changeLine({ kind: 'changed', phase, ref: 'flarewall_a', description: 'a', fields: ['expression'] })}`)).toBe(MOCHA.yellow);
    expect(lineColor(`  ${changeLine({ kind: 'setting', setting: 'always_use_https', expected: 'on', actual: 'off' })}`)).toBe(MOCHA.yellow);
    expect(lineColor(`  ${foreignLine('legacy', { phase, id: 'old-1', description: 'Block ports' })}`)).toBe(MOCHA.pink);
    expect(lineColor(`  ${foreignLine('unowned', { phase, id: 'hand-1', description: 'Allow office' })}`)).toBe(MOCHA.overlay1);
  });

  it('colours the plan steps and the run outcome lines', () => {
    expect(lineColor(`    ${stepLine({ kind: 'create', ref: 'flarewall_a', description: 'a' })}`)).toBe(MOCHA.green);
    expect(lineColor('  http_ratelimit: no change')).toBe(MOCHA.overlay1);
    expect(lineColor('example.com: applied, read-back in sync')).toBe(MOCHA.green);
    expect(lineColor('example.com: declined, nothing sent')).toBe(MOCHA.subtext0);
    expect(lineColor('example.com: error: updatePhase failed')).toBe(MOCHA.red);
    expect(lineColor('example.com: backup written to /tmp/x')).toBe(MOCHA.sapphire);
    expect(lineColor('Apply the baseline to example.org? [y/N]')).toBe(MOCHA.red);
    expect(lineColor('Plan       free')).toBeUndefined();
  });
});
