import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { query, queryLine } from '../core/git-run.ts';
import { errorCode } from '../core/guards.ts';
import { findProgram, type PathSearchDeps } from '../core/path-search.ts';
import { programLookup, type ExecRequest } from './request.ts';

/** The lockfiles a repository root may hold; a binding needs exactly one, so which install it pins is never a guess. */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] as const;

/** What the run-time binding check reads from a checkout; each answer is undefined when git or the file cannot tell. */
export interface CheckoutProbe {
  /** The root of the checkout `dir` is in. */
  topLevel(dir: string): Promise<string | undefined>;
  /** The full id of the commit checked out in `dir`. */
  head(dir: string): Promise<string | undefined>;
  /** The changed and untracked paths `git status` lists in `dir`, one line each. */
  changes(dir: string): Promise<readonly string[] | undefined>;
  /** The SHA-256 of a file's bytes; undefined when there is no file. */
  fileSha256(path: string): Promise<string | undefined>;
}

/** The real checkout, through the git CLI and the filesystem. */
export const GIT_CHECKOUT: CheckoutProbe = {
  async topLevel(dir) {
    return queryLine(dir, ['rev-parse', '--show-toplevel']);
  },
  async head(dir) {
    return queryLine(dir, ['rev-parse', 'HEAD']);
  },
  async changes(dir) {
    return query(dir, ['status', '--porcelain'])
      ?.split('\n')
      .filter((line) => line.trim() !== '');
  },
  async fileSha256(path) {
    try {
      return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  },
};

/** What the binding check reads: the checkout, and the exec PATH a program name is looked up on. */
export interface BindingDeps {
  readonly checkout: CheckoutProbe;
  readonly search: PathSearchDeps;
}

/** Which of a request's commands is about to start: the read-only dry run, or the approved run. */
export type ExecStage = 'dry-run' | 'run';

/** The command a stage starts: its program as the request stored it, resolved, and its argv; undefined for a dry run the request has none of. */
export function stageCommand(request: ExecRequest, stage: ExecStage): { readonly program: string; readonly argv: readonly string[] } | undefined {
  if (stage === 'run') return { program: request.program, argv: request.argv };
  return request.dryRunArgv === null || request.dryRunProgram === null ? undefined : { program: request.dryRunProgram, argv: request.dryRunArgv };
}

/** The file `argv0` starts: an absolute path that is a file, or a name found on the exec PATH; undefined when neither. */
export async function resolveProgram(argv0: string, search: PathSearchDeps): Promise<string | undefined> {
  const lookup = programLookup(argv0);
  switch (lookup.kind) {
    case 'absolute':
      return (await search.probe.kind(lookup.path)) === 'file' ? lookup.path : undefined;
    case 'name':
      return findProgram(lookup.name, search);
    case 'refused':
      return undefined;
  }
}

/** Whether two paths name one place; Windows paths ignore case and slash direction. */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  return paths.relative(paths.resolve(left), paths.resolve(right)) === '';
}

async function lockfileProblems(repo: string, lockSha256: string, deps: BindingDeps): Promise<string[]> {
  const paths = deps.search.platform === 'win32' ? win32 : posix;
  const hashed = await Promise.all(LOCKFILES.map(async (name) => ({ name, sha: await deps.checkout.fileSha256(paths.join(repo, name)) })));
  const found = hashed.flatMap(({ name, sha }) => (sha === undefined ? [] : [{ name, sha }]));
  const [lock, ...others] = found;
  if (lock === undefined) {
    return [`${repo} has no lockfile (${LOCKFILES.join(', ')})`];
  }
  if (others.length > 0) {
    return [`${repo} has ${found.length} lockfiles (${found.map(({ name }) => name).join(', ')}): keep one`];
  }
  return lock.sha === lockSha256 ? [] : [`${lock.name} changed since the request (SHA-256 ${lock.sha.slice(0, 12)}, bound ${lockSha256.slice(0, 12)})`];
}

/**
 * Why `stage` of `request` must not start now; empty when it may (spec §8). The code must be what was reviewed: the cwd's
 * checkout is the bound repository at the bound commit, with no uncommitted change and the bound lockfile, and the
 * program re-resolves to the file the request stored. An image binding (a pod exec) cannot be checked yet, so it is refused.
 */
export async function bindingProblems(request: ExecRequest, stage: ExecStage, deps: BindingDeps): Promise<readonly string[]> {
  const { binding } = request;
  if (!('repo' in binding)) {
    return [`${request.id} binds an image, whose digest cannot be checked yet: a pod exec is run by hand with the owner`];
  }
  const command = stageCommand(request, stage);
  if (command === undefined) {
    return [`${request.id} has no dry run`];
  }
  const { program: stored, argv } = command;
  const { checkout, search } = deps;
  const [topLevel, head, changes, program] = await Promise.all([checkout.topLevel(request.cwd), checkout.head(binding.repo), checkout.changes(binding.repo), resolveProgram(argv[0] ?? '', search)]);
  const problems: string[] = [];
  if (topLevel === undefined) {
    problems.push(`cwd ${request.cwd} is in no git checkout`);
  } else if (!samePath(topLevel, binding.repo, search.platform)) {
    problems.push(`cwd ${request.cwd} is in the checkout ${topLevel}, not the bound ${binding.repo}`);
  }
  if (head !== binding.commit) {
    problems.push(`${binding.repo} is at ${head?.slice(0, 12) ?? 'no commit'}, bound to ${binding.commit.slice(0, 12)}`);
  }
  if (changes === undefined) {
    problems.push(`git status cannot read ${binding.repo}`);
  } else if (changes.length > 0) {
    problems.push(`${binding.repo} has ${changes.length} uncommitted change(s): commit or remove them`);
  }
  problems.push(...(await lockfileProblems(binding.repo, binding.lockSha256, deps)));
  if (program === undefined || !samePath(program, stored, search.platform)) {
    problems.push(`${argv[0] ?? ''} now resolves to ${program ?? 'nothing'}, not the reviewed ${stored}`);
  }
  return problems;
}
