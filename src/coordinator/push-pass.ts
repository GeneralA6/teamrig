import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { KIT_VERSION } from '../core/version.ts';

/**
 * Git opens a push's connection before its pre-push hook runs, so checks that wait in the host lock's line keep the
 * connection idle all that time, and a host such as GitHub drops it: the push then fails with SIGPIPE after its checks
 * passed (T730: pushes lost after 11.5 and 20 minutes, while checks alone took 3-4). A wait longer than this declines
 * the push; the next push of the same tree reuses the checks' pass and goes at once.
 */
export const PRE_PUSH_MAX_WAIT_MS = 60_000;

/** How long a pass stays good for a push of the same tree; older passes are pruned whenever one is recorded. */
export const PASS_KEPT_MS = 24 * 60 * 60_000;

/** A git working tree as a pre-push hook's checks see it. */
export type CheckedTree =
  /** Nothing uncommitted: `tree` and `commit` are HEAD's ids, `gitDir` the git folder the repository's worktrees share. */
  | { readonly kind: 'clean'; readonly tree: string; readonly commit: string; readonly gitDir: string }
  /** Uncommitted or untracked changes, which the checks test but a push does not carry. */
  | { readonly kind: 'changed' }
  /** No repository, no commit yet, or no git. */
  | { readonly kind: 'none' };

export type CleanTree = Extract<CheckedTree, { kind: 'clean' }>;

/** Reads a folder's working tree. */
export interface TreeState {
  checked(dir: string): CheckedTree;
}

/** Checks that passed on one clean tree: the record a push of the same tree reuses. */
export interface PushPass {
  readonly tree: string;
  readonly commit: string;
  /** The checks' command line, as the shell ran it. */
  readonly command: string;
  /** The checks' label (`queue --what`). */
  readonly what: string;
  /** When they passed, as an ISO time. */
  readonly passedAt: string;
  readonly kit: string;
}

/** A pass's file name: its tree id, then the start of its command line's hash. */
const PASS_FILE = /^[0-9a-f]+-[0-9a-f]{16}\.json$/;

function passFolder(tree: CleanTree): string {
  return join(tree.gitDir, 'teamrig', 'pre-push');
}

/** Where the pass of `command` on this tree is kept: checks with another command line keep their own. */
function passPath(tree: CleanTree, command: string): string {
  const hash = createHash('sha256').update(command).digest('hex').slice(0, 16);
  return join(passFolder(tree), `${tree.tree}-${hash}.json`);
}

function parsePass(text: string): PushPass | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const [tree, commit, command, what, passedAt, kit] = ['tree', 'commit', 'command', 'what', 'passedAt', 'kit'].map((key) => stringField(value, key));
  return tree === undefined || commit === undefined || command === undefined || what === undefined || passedAt === undefined || kit === undefined
    ? undefined
    : { tree, commit, command, what, passedAt, kit };
}

/** A pass younger than PASS_KEPT_MS; one stamped later than now is not trusted. */
function isFresh(pass: PushPass, now: number): boolean {
  const age = now - Date.parse(pass.passedAt);
  return age >= 0 && age < PASS_KEPT_MS;
}

/** The pass of `command` on this tree while it is fresh; undefined when there is none. */
export async function passOf(files: Files, tree: CleanTree, command: string, now: number): Promise<PushPass | undefined> {
  const pass = parsePass((await files.read(passPath(tree, command))) ?? '');
  return pass !== undefined && pass.tree === tree.tree && pass.command === command && isFresh(pass, now) ? pass : undefined;
}

/** Records that `command` passed on this tree, and removes the passes that are no longer fresh or cannot be read. */
export async function recordPass(files: Files, tree: CleanTree, command: string, what: string, now: number): Promise<void> {
  const pass: PushPass = { tree: tree.tree, commit: tree.commit, command, what, passedAt: new Date(now).toISOString(), kit: KIT_VERSION };
  await files.write(passPath(tree, command), `${JSON.stringify(pass)}\n`);
  const folder = passFolder(tree);
  for (const name of (await files.list(folder)).filter((entry) => PASS_FILE.test(entry))) {
    const path = join(folder, name);
    const kept = parsePass((await files.read(path)) ?? '');
    if (kept === undefined || !isFresh(kept, now)) {
      await files.remove(path);
    }
  }
}
