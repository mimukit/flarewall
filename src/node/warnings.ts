// Node-only: Node 22 prints an ExperimentalWarning when node:sqlite loads. The CLI drops that one
// warning, so it never mixes with command output. Every other warning still prints.
type EmitWarning = typeof process.emitWarning;

/** True for the node:sqlite ExperimentalWarning. */
export function isSqliteWarning(warning: string | Error, typeOrOptions?: unknown): boolean {
  const type = warning instanceof Error ? warning.name : typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type?: string } | undefined)?.type;
  const text = warning instanceof Error ? warning.message : warning;
  return type === 'ExperimentalWarning' && /SQLite/i.test(text);
}

/** Wraps process.emitWarning to drop the node:sqlite ExperimentalWarning. Call it before node:sqlite loads. */
export function quietSqliteWarning(): void {
  const original: EmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (isSqliteWarning(warning, rest[0])) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
}
