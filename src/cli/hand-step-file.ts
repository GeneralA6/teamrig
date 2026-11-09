import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Task } from '../register/fold.ts';
import type { AuditPin, RunFiles } from '../register/hand-step.ts';
import { UsageError } from './args.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The pin of the hand step file `typed` names (T2312, core rule 11), read from the caller's folder: its absolute path
 * and the sha256 of its bytes now, as `audit --file` pins it and `set --run` matches it. `flag` names the flag that
 * typed it, for the usage error a blank path or one with a line break gets (parseAuditPin reads such a pin back as
 * bad, so the register line it wrote would be lost); a missing file is refused.
 */
export async function handStepPin(runtime: CliRuntime, flag: string, typed: string): Promise<AuditPin> {
  if (typed.trim() === '') {
    throw new UsageError(`--${flag} needs the hand step file's path`);
  }
  if (/[\r\n]/.test(typed)) {
    throw new UsageError(`--${flag} takes the hand step file's path on one line: a path with a line break is not pinned`);
  }
  const path = resolve(runtime.cwd, typed);
  const sha256 = await sha256Now(runtime, path);
  if (sha256 === null) {
    throw new RefusedError(`no file ${path}`);
  }
  return { path, sha256 };
}

/** The sha256 of the file at `path` now, in lowercase hex as an audit pins it; null when there is none. */
async function sha256Now(runtime: CliRuntime, path: string): Promise<string | null> {
  const bytes = await runtime.fileBytes.read(path);
  return bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
}

/**
 * What each hand step file the cards of `tasks` hand the owner hashes to now (T2312), read as handStepPin reads it,
 * each file once, so a card printed from it shows the run line only while the file still has its audit's sha256.
 */
export async function readRunFiles(runtime: CliRuntime, tasks: Iterable<Task>): Promise<RunFiles> {
  const paths = new Set(
    [...tasks].flatMap((task) => {
      const run = task.card?.run;
      return run === undefined ? [] : [run];
    }),
  );
  return new Map(await Promise.all([...paths].map(async (path): Promise<[string, string | null]> => [path, await sha256Now(runtime, path)])));
}
