import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { Env } from '../core/home.ts';
import type { HookEnd, HookRunner } from '../deploy/hooks.ts';
import type { MergeGit } from './git.ts';
import { installTouches, LOCKFILE, MANIFEST_FILE, packageFilesChange } from './manifest.ts';

/** Names, for the dependency check, the file holding the base's package-lock.json. */
export const BASELINE_LOCK_ENV = 'TEAMRIG_BASELINE_LOCK';

/** The git reads a range's dependency check needs. */
export type RangeReader = Pick<MergeGit, 'changedPaths' | 'fileAt'>;

/**
 * The root package files the commits `from..to` of the checkout at `dir` change in a way that needs a dependency
 * install, as `installTouches` names them: empty when none does, undefined when the range's paths could not be read.
 */
export async function rangeInstallTouches(git: RangeReader, dir: string, from: string, to: string): Promise<string[] | undefined> {
  const paths = git.changedPaths(dir, from, to);
  if (paths === undefined) {
    return undefined;
  }
  return installTouches(await packageFilesChange(paths, async (end) => git.fileAt(dir, end === 'before' ? from : to, MANIFEST_FILE)));
}

/** A dependency check to run on a change: `delivery.repos.<name>.dependencyCheck` in the checkout at the change. */
export interface DependencyCheck {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The base's package-lock.json; undefined when the base has none, which leaves {@link BASELINE_LOCK_ENV} unset. */
  readonly baseline: string | undefined;
  /** The folder the baseline's file is written in, for the check's run only. */
  readonly folder: string;
  readonly env: Env;
  readonly timeoutMs: number;
  readonly onLine: (line: string) => void;
}

export interface DependencyCheckPorts {
  readonly hooks: HookRunner;
  readonly files: Files;
  newId(): string;
}

/** Runs the check with the base's package-lock.json in the file {@link BASELINE_LOCK_ENV} names, removed after however the check ends. */
export async function runDependencyCheck(ports: DependencyCheckPorts, check: DependencyCheck): Promise<HookEnd> {
  const { argv, cwd, baseline, env, timeoutMs, onLine } = check;
  const file = baseline === undefined ? undefined : { path: join(check.folder, `baseline-${ports.newId()}.${LOCKFILE}`), text: baseline };
  if (file !== undefined) {
    await ports.files.write(file.path, file.text);
  }
  try {
    return await ports.hooks.run({ argv, cwd, env: { ...env, [BASELINE_LOCK_ENV]: file?.path }, timeoutMs, onLine });
  } finally {
    if (file !== undefined) {
      await ports.files.remove(file.path);
    }
  }
}
