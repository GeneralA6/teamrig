import type { ChangeQuery, ChangeRead } from '../source.ts';

/** The paths a git read narrows to: the asked file or folder, else the whole project. */
export function pathsOf(query: ChangeQuery): string[] {
  return query.file === undefined ? [] : [query.file];
}

/** A read that threw, as the failed read the core prints beside the other sources' entries. */
export function readFailure(error: unknown): ChangeRead {
  return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
}
