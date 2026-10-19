import { join } from 'node:path';
import type { Files } from '../core/files.ts';

/**
 * What the shell a Bash call runs in exports past the hook's environment: Claude Code sources a snapshot of the
 * user's shell (`<config dir>/shell-snapshots/snapshot-<shell>-<ms>-<id>.sh`) before each call's line, and an
 * `export` there reaches every program the line runs.
 */
export interface SnapshotExports {
  /** The names it exports: `export NAME=...`, `declare -x NAME`, `typeset -gx NAME`. */
  readonly names: ReadonlySet<string>;
  /** True when it turns on `set -a` (`set -o allexport`), under which every later assignment exports too. */
  readonly all: boolean;
}

export const NO_SNAPSHOT: SnapshotExports = { names: new Set(), all: false };

/** A snapshot's file name, capturing its creation time in milliseconds. */
const SNAPSHOT_FILE = /^snapshot-\w+-(\d+)-\w+\.sh$/;
/** A quoted string, single or double, whose separators end nothing. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
/** A command that exports, `export` or `declare`, `typeset` or `local` with an `x` among its flags, up to the next separator. */
const EXPORTING = /(?:^|[\s;&|({])(?:export|(?:declare|typeset|local)\s+-[A-Za-z]*x[A-Za-z]*)\s+([^;&|)}]*)/g;
/** `set -a`, `set -ea`... or `set -o allexport`. */
const ALL_EXPORT = /(?:^|[\s;&|({])set\s+(?:[-+]o\s+allexport\b|-[A-Za-z]*a)/;
/** A name an exporting command is given: a bare word, or the name before `=` or `+=`. */
const DECLARED_NAME = /(?:^|\s)([A-Za-z_]\w*)(?=\+?=|\s|$)/g;

/**
 * The names a snapshot's text exports and whether it turns on `set -a`, read line by line with patterns that find
 * more than bash would (a function's `export` counts although only a call runs it), never less. Each quoted string
 * first becomes its content with every character but a word's turned to `_`: bash removes the quotes before
 * `export` reads `'C'=2`, and a `;` or `|` inside quotes separates nothing.
 */
export function snapshotExportsIn(text: string): SnapshotExports {
  const names = new Set<string>();
  let all = false;
  for (const line of text.split('\n')) {
    all ||= ALL_EXPORT.test(line);
    const unquoted = line.replace(QUOTED, (quoted) => quoted.slice(1, -1).replace(/\W/g, '_'));
    for (const [, declared] of unquoted.matchAll(EXPORTING)) {
      for (const [, name] of (declared ?? '').matchAll(DECLARED_NAME)) {
        if (name !== undefined) {
          names.add(name);
        }
      }
    }
  }
  return { names, all };
}

/** The newest snapshot under `dir` (`<config dir>/shell-snapshots`), as the shell a Bash call starts now sources it; none when there is none. */
export async function newestSnapshotExports(files: Files, dir: string): Promise<SnapshotExports> {
  let newest: { readonly name: string; readonly made: number } | undefined;
  for (const name of await files.list(dir)) {
    const digits = SNAPSHOT_FILE.exec(name)?.[1];
    const made = digits === undefined ? undefined : Number(digits);
    if (made !== undefined && (newest === undefined || made > newest.made)) {
      newest = { name, made };
    }
  }
  const text = newest === undefined ? undefined : await files.read(join(dir, newest.name));
  return text === undefined ? NO_SNAPSHOT : snapshotExportsIn(text);
}
