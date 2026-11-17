import { join } from 'node:path';
import type { Env } from '../core/home.ts';
import { isTemporaryName, type Files } from '../core/files.ts';
import { isRecord, isStringArray, stringField } from '../core/guards.ts';

/** The folder of parked steps, inside the detached folder (`detachedDirOf`). */
export const PARKED_DIR = 'parked';

/** The suffix of a parked step's file. */
export const PARKED_SUFFIX = '.parked.json';

/** The parked step's format; a field added is a new format (CONTRIBUTING, Stored files). */
export const PARKED_FORMAT = 1;

/**
 * A step `queue --detach` parked (T4093): what the host's one dispatcher (`queue --dispatch`) needs to run it as a
 * detached run in its own process, so a step waiting for its turn holds a file, not a node process of its own.
 */
export interface ParkedStep {
  readonly v: typeof PARKED_FORMAT;
  /** The detached run's id (`detachedIdOf`), which names its log and run record too. */
  readonly id: string;
  /** The team whose step it is: the detached folder may be shared by every team pointing `delivery.dir` at one place. */
  readonly team: string;
  readonly session: string;
  readonly what: string;
  readonly log: string;
  /** The CLI arguments of its detached run, from `queue` on (`detachedArgsOf`). */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The parking command's allow-listed variables (`parkedEnvOf`), so no secret reaches the disk. */
  readonly env: Env;
  /** An ISO time: when it was parked. */
  readonly parkedAt: string;
}

/** The parked folder of the detached folder `detachedDir`. */
export function parkedDirOf(detachedDir: string): string {
  return join(detachedDir, PARKED_DIR);
}

/** The file of the parked step `id` in the parked folder `dir`. */
export function parkedPathOf(dir: string, id: string): string {
  return join(dir, `${id}${PARKED_SUFFIX}`);
}

export function formatParked(step: ParkedStep): string {
  return `${JSON.stringify(step)}\n`;
}

/** `value` as an environment, or undefined when one of its values is not text. */
function envOf(value: unknown): Env | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== 'string') {
      return undefined;
    }
    env[name] = text;
  }
  return env;
}

/** The parked step in `text`, or undefined when it is not one. */
export function parseParked(text: string): ParkedStep | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value['v'] !== PARKED_FORMAT) {
    return undefined;
  }
  const record = value;
  const [id, team, session, what, log, cwd, parkedAt] = ['id', 'team', 'session', 'what', 'log', 'cwd', 'parkedAt'].map((key) => stringField(record, key));
  const argv = record['argv'];
  const env = envOf(record['env']);
  if (id === undefined || team === undefined || session === undefined || what === undefined || log === undefined || cwd === undefined || parkedAt === undefined || !isStringArray(argv) || env === undefined) {
    return undefined;
  }
  return { v: PARKED_FORMAT, id, team, session, what, log, argv, cwd, env, parkedAt };
}

/** Parks a step in the parked folder `dir`: written whole (write then rename), so a dispatcher never reads half of it. */
export async function park(files: Pick<Files, 'write'>, dir: string, step: ParkedStep): Promise<string> {
  const path = parkedPathOf(dir, step.id);
  await files.write(path, formatParked(step));
  return path;
}

/**
 * Whether the parked folder `dir` holds a step of any team, so a dispatcher is still needed. `skip` holds the paths a
 * dispatcher already found are no step (`claimParked`'s unreadable): they would keep it running with nothing to run.
 */
export async function hasParked(files: Pick<Files, 'list'>, dir: string, skip: ReadonlySet<string> = new Set()): Promise<boolean> {
  return (await files.list(dir)).some((name) => name.endsWith(PARKED_SUFFIX) && !isTemporaryName(name) && !skip.has(join(dir, name)));
}

/** What claiming the parked folder found: the steps this call took, oldest first, and the files that are no step. */
export interface Claimed {
  readonly steps: readonly ParkedStep[];
  readonly unreadable: readonly string[];
}

/**
 * Takes every parked step in `dir`, oldest first: each is read, then removed, and only a step whose removal this
 * call made is taken, so of two dispatchers that both read one, only one runs it. A file that is no parked step is
 * left and named, for the caller to report, never run.
 */
export async function claimParked(files: Pick<Files, 'list' | 'read' | 'remove'>, dir: string): Promise<Claimed> {
  const steps: ParkedStep[] = [];
  const unreadable: string[] = [];
  for (const name of (await files.list(dir)).sort()) {
    if (!name.endsWith(PARKED_SUFFIX) || isTemporaryName(name)) {
      continue;
    }
    const path = join(dir, name);
    const text = await files.read(path);
    if (text === undefined) {
      continue;
    }
    const step = parseParked(text);
    if (step === undefined) {
      unreadable.push(path);
      continue;
    }
    if (await files.remove(path)) {
      steps.push(step);
    }
  }
  return { steps: steps.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt)), unreadable };
}
