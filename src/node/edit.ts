// Node-only: edits a document in $EDITOR through a private temp file.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Opens the editor on a file and resolves when it exits. Tests pass a fake. */
export type Editor = (file: string) => Promise<void>;

const ERROR_PREFIX = '# flarewall: ';

/** The editor in $VISUAL or $EDITOR (vi when neither is set), run through sh so it can carry flags. */
export function shellEditor(env: Record<string, string | undefined>): Editor {
  const command = env.VISUAL || env.EDITOR || 'vi';
  return (file) =>
    new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', `${command} "$1"`, 'sh', file], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the editor (${command}) exited with code ${code}`))));
    });
}

/** Drops the error lines this module put at the top of the file. */
function stripErrors(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith(ERROR_PREFIX)) i++;
  return lines.slice(i).join('\n');
}

/**
 * Writes `text` to a temp file (mode 0600 in a 0700 directory), opens the editor, and checks the
 * result with `validate`. An invalid file reopens with the error at the top. Resolves with the
 * edited text, or undefined when the owner empties the file to cancel. The temp file is deleted.
 */
export async function editText(text: string, validate: (text: string) => void, editor: Editor): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'flarewall-edit-'));
  const file = join(dir, 'document.yaml');
  try {
    let content = text;
    for (;;) {
      await writeFile(file, content, { mode: 0o600 });
      await editor(file);
      const edited = stripErrors(await readFile(file, 'utf8'));
      if (edited.trim() === '') return undefined;
      try {
        validate(edited);
        return edited;
      } catch (error) {
        const lines = (error as Error).message.split('\n').map((l) => `${ERROR_PREFIX}${l}`);
        content = [...lines, `${ERROR_PREFIX}fix the file and save it, or empty it to cancel`, edited].join('\n');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
