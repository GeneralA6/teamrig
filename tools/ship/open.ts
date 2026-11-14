import { type MergeDeps, pushedHead, realMergeDeps } from './merge.ts';
import { findOpenPull, openPull } from './pulls.ts';
import { describeCredential } from './token-check.ts';

/**
 * `ship.ts open`: opens the pull request of a pushed change branch into main with the ship key, and stops there, so a
 * change that needs review before it merges has a pull request to review. Sessions' own gh logins cannot open pull
 * requests, and `ship.ts merge` merges as soon as the gate passes. It makes merge's checks first (never main, pushed
 * as it is, commits main lacks, the note file read: merge.ts pushedHead) and the same title and body; an open pull
 * request from the branch is reported, not opened again. It runs no gate and merges nothing: `ship.ts merge` later
 * finds that pull request, proves its head and merges it.
 */

export interface OpenArgs {
  dir: string;
  /** The branch to open the pull request from; null means the one checked out in the repo dir. */
  head: string | null;
  /** A Markdown file whose text opens the pull request's body; null for none. */
  noteFile: string | null;
}

export const OPEN_USAGE = 'usage: ship.ts open <repo dir> [--head <branch>] [--note-file <path>]';

export function parseOpenArgs(argv: readonly string[]): OpenArgs {
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(OPEN_USAGE);
  const parsed: OpenArgs = { dir, head: null, noteFile: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--head' && /^[\w./-]+$/.test(value)) parsed.head = value;
    else if (flag === '--note-file' && !value.startsWith('--')) parsed.noteFile = value;
    else throw new Error(`${OPEN_USAGE} (got ${flag} ${value})`);
  }
  return parsed;
}

/** What opening reaches outside itself: merge's git, profiles, key, gh and output; no gate run, no clock. */
export type OpenDeps = Pick<MergeDeps, 'git' | 'profiles' | 'gate' | 'credential' | 'ghFor' | 'out' | 'err'>;

/** Opens (or finds) the pull request; 0 once one is open from the pushed head, else 1 with the reason. */
export function runOpen(args: OpenArgs, deps: OpenDeps): number {
  const { repo, profile, head, sha, title, body } = pushedHead(deps, args.head, args.noteFile);
  const credential = deps.credential();
  if (credential.kind !== 'found') {
    deps.err(describeCredential(credential));
    return 1;
  }
  const gh = deps.ghFor(credential.secret);
  const found = findOpenPull(gh, repo, head, profile.main);
  const pull = found ?? openPull(gh, repo, head, profile.main, title, body);
  if (pull.headSha !== sha) {
    deps.err(`REFUSED the pull request #${pull.number} head ${pull.headSha.slice(0, 7)} is not ${head} ${sha.slice(0, 7)}: GitHub has not seen the push yet, so run open again`);
    return 1;
  }
  deps.out(`${found === null ? 'OPENED' : 'FOUND'} #${pull.number} ${pull.url}`);
  deps.out(`it stays open for review: merge it with ship.ts merge ${args.dir}${args.head === null ? '' : ` --head ${head}`}`);
  return 0;
}

/** `ship.ts open ...`: the exit code; a usage or git error is one line, never a stack. */
export function openCommand(argv: readonly string[], depsFor: (dir: string) => OpenDeps = realMergeDeps): number {
  let err: (line: string) => void = line => console.error(line);
  try {
    const args = parseOpenArgs(argv);
    const deps = depsFor(args.dir);
    err = deps.err;
    return runOpen(args, deps);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
