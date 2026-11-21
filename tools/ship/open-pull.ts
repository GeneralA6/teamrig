import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { nodeFiles } from '../../src/core/files.ts';
import { realSleep, systemClock } from '../../src/core/lock.ts';
import { gitSyncIn } from '../lib/git.ts';
import { type ClearMerge, clearMergeFrom } from './approval.ts';
import { type Gh, ghWithToken } from './github.ts';
import { type Credential, SHIP_TOKEN_TARGET, readCredential, windowsPowerShell } from './keychain.ts';
import { lackingSections, missingSections, pullBody, pullTitle } from './merge.ts';
import { findOpenPull, openPull } from './pulls.ts';
import { type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';
import { APPROVED_SHA } from './ship-plan.ts';
import { pullCommitsOf, supersedeFrom } from './superseded.ts';
import { describeCredential } from './token-check.ts';

/**
 * `ship.ts pr`: opens the pull request of a head already pushed and approved, with the ship token, and prints its URL
 * (T4364). A branch pushed outside ship.ts (its push hook ran the local gate) gets no pull request from a session's own
 * gh login, since only the ship token may create one, so the owner opened it by hand. This runs no gate and merges
 * nothing: origin's head must be the approved sha and clear on that approval as a merge would (approval.ts), and the
 * note must hold the template's sections (missingSections); an open pull request of that head is found, not opened again.
 */

export interface OpenPullArgs {
  dir: string;
  head: string;
  /** The head sha the caller's approver approved; origin's head of `head` must be it. */
  approved: string;
  /** The Markdown file opening the pull request's body; null for none. */
  noteFile: string | null;
}

const USAGE = 'usage: ship.ts pr <repo dir> --head <branch> --approved <sha> [--note-file <path>]';

export function parseOpenPullArgs(argv: readonly string[]): OpenPullArgs {
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--')) throw new Error(USAGE);
  let head: string | null = null;
  let approved: string | null = null;
  let noteFile: string | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--head' && /^[\w./-]+$/.test(value)) head = value;
    else if (flag === '--approved' && APPROVED_SHA.test(value)) approved = value;
    else if (flag === '--note-file' && !value.startsWith('--')) noteFile = value;
    else throw new Error(`${USAGE} (got ${flag} ${value})`);
  }
  if (head === null || approved === null) throw new Error(`${USAGE} (--head and --approved are required)`);
  return { dir, head, approved, noteFile };
}

/** What the command reaches outside itself, so a test can stand in for each. */
export interface OpenPullDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  profiles: ReadonlyMap<string, RepoProfile>;
  credential: () => Credential;
  ghFor: (token: string) => Gh;
  /** Whether the caller may merge the branch at its head on the approval it names (approval.ts, T2788). */
  clearMerge: ClearMerge;
  /** A file's text, or null when there is none. */
  readText: (path: string) => string | null;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Why the pull request is not opened, said once as a REFUSED line; the exit code. */
function refuse(deps: OpenPullDeps, reason: string): number {
  deps.err(`REFUSED ${reason}`);
  return 1;
}

export async function runOpenPull(args: OpenPullArgs, deps: OpenPullDeps): Promise<number> {
  const { git } = deps;
  const repo = slugOf(git('remote', 'get-url', 'origin'));
  const profile = profileFor(deps.profiles, repo);
  const { head, approved } = args;
  if (head === profile.main) throw new Error(`${head} is the branch merged into: name a change branch`);
  git('fetch', '--quiet', 'origin', head, profile.main);
  // Origin's head, not a local branch: the branch may have been pushed from another worktree.
  const sha = git('rev-parse', `refs/remotes/origin/${head}`);
  if (!sha.startsWith(approved)) return refuse(deps, `origin's ${head} is at ${sha.slice(0, 9)}, not the approved ${approved.slice(0, 9)}: push the approved head, or ask for approval of ${sha.slice(0, 9)}`);
  const subjects = git('log', '--reverse', '--format=%s', `refs/remotes/origin/${profile.main}..${sha}`).split('\n').filter(line => line !== '');
  if (subjects.length === 0) throw new Error(`${head} has nothing that ${profile.main} lacks`);
  const note = args.noteFile === null ? null : deps.readText(args.noteFile);
  if (args.noteFile !== null && note === null) throw new Error(`--note-file ${args.noteFile}: no such file`);

  const clearance = await deps.clearMerge(head, sha, approved);
  if (clearance.kind === 'refused') return refuse(deps, clearance.reason);
  const credential = deps.credential();
  if (credential.kind !== 'found') {
    deps.err(describeCredential(credential));
    return 1;
  }
  const gh = deps.ghFor(credential.secret);
  // The earlier pushes' pull requests of this change, which the one found or opened replaces (T4780).
  const supersede = supersedeFrom(gh, repo, profile.main, pullCommitsOf(git, profile.main, profile.regenerated), deps.out);
  const found = findOpenPull(gh, repo, head, profile.main);
  if (found !== null) {
    if (found.headSha !== sha) return refuse(deps, `pull request #${found.number} ${found.url} is at ${found.headSha.slice(0, 9)}, not ${sha.slice(0, 9)}`);
    deps.out(`found pull request #${found.number} ${found.url}`);
    supersede(found);
    return 0;
  }
  const lacks = missingSections(note, profile.pullSections);
  if (lacks !== null) return refuse(deps, lackingSections(lacks));
  const pull = openPull(gh, repo, head, profile.main, pullTitle(head, profile.main, subjects.length), pullBody(subjects, note));
  // A push between the read above and the call would open the pull request at a head nobody approved.
  if (pull.headSha !== sha) return refuse(deps, `pull request #${pull.number} ${pull.url} opened at ${pull.headSha.slice(0, 9)}, not the approved ${sha.slice(0, 9)}: ${head} moved, so close it`);
  deps.out(`opened pull request #${pull.number} ${pull.url}`);
  supersede(pull);
  return 0;
}

/** The real git, keychain, gh and approval reads for a repo dir. */
export function realOpenPullDeps(dir: string): OpenPullDeps {
  const runGit = gitSyncIn(dir);
  return {
    git: (...gitArgs) => runGit(gitArgs).trim(),
    profiles: readProfiles(),
    credential: () => readCredential(SHIP_TOKEN_TARGET, windowsPowerShell),
    ghFor: ghWithToken,
    clearMerge: clearMergeFrom(process.env, { env: process.env, userHome: homedir(), files: nodeFiles(realSleep), clock: systemClock }),
    readText: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    out: line => console.log(line),
    err: line => console.error(line),
  };
}

/** `ship.ts pr ...`: the exit code; a usage or git error is one line, never a stack. */
export async function openPullCommand(argv: readonly string[], depsFor: (dir: string) => OpenPullDeps = realOpenPullDeps): Promise<number> {
  let err: (line: string) => void = line => console.error(line);
  try {
    const args = parseOpenPullArgs(argv);
    const deps = depsFor(args.dir);
    err = deps.err;
    return await runOpenPull(args, deps);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
