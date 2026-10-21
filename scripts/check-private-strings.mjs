// Fails when a file in the repo contains a private string.
//
// FLAREWALL_PRIVATE_STRINGS holds the strings, one per line. The match is case-insensitive.
// The check scans every tracked file plus untracked files that git does not ignore, so a
// local run also covers new files. It exits 2 when the list is empty or missing, so a
// missing CI secret never passes as clean. It prints the file, the line, and the list
// position of each hit, never the private string itself.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const strings = (process.env.FLAREWALL_PRIVATE_STRINGS ?? '')
  .split(/\r?\n/)
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== '');

if (strings.length === 0) {
  console.error('FLAREWALL_PRIVATE_STRINGS is empty or not set. Set it to the private strings, one per line.');
  process.exit(2);
}

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '');

let hits = 0;
let scanned = 0;
for (const file of [...new Set(files)]) {
  let text;
  try {
    if (!statSync(file).isFile()) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  scanned += 1;
  const lines = text.toLowerCase().split('\n');
  lines.forEach((line, i) => {
    strings.forEach((s, n) => {
      if (line.includes(s)) {
        console.error(`${file}:${i + 1}: private string #${n + 1}`);
        hits += 1;
      }
    });
  });
}

if (hits > 0) {
  console.error(`Found ${hits} private string hit(s) in ${scanned} files.`);
  process.exit(1);
}
console.log(`No private strings in ${scanned} files (${strings.length} strings checked).`);
