import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readTextIfPresent } from '../lib/files.ts';
import { createGit, type Git } from '../lib/git.ts';
import { isRecord } from '../lib/guards.ts';

/**
 * The local gate: runs every check CI runs on a committed tree, on this machine, and records the pass so a
 * tree is checked once. The record lives at `<git common dir>/local-ci/<tree sha>.json`, so every worktree of
 * the clone shares it, and is written only when every check passed on a clean checkout the checks left as
 * they found it:
 *   { "tree": "<sha>", "commit": "<sha>", "checks": ["<name>", ...], "passedAt": "<ISO time>", "node": "<version>" }
 * The pre-push hook and `tools/ci/local.ts` read it first; any tool that proves a tree the same way may write it.
 */

/** One check: a CI job or step, as a command run from the repo root. */
export interface LocalCheck {
  /** What it prints; CI's job name where the job is one check. */
  readonly name: string;
  /** The program and its arguments; `node` runs this Node. */
  readonly argv: readonly [string, ...string[]];
  /** The folder it runs in, relative to the repo root; the root when absent. */
  readonly cwd?: string;
  /** Runs with an empty home and Claude config folder, so no account, settings or other plugins reach it. */
  readonly isolatedHome?: boolean;
}

export interface CheckRun {
  /** The exit code; null when the program did not start or was killed. */
  readonly status: number | null;
  /** Its stdout, then its stderr. */
  readonly output: string;
  readonly ms: number;
}

export interface PassRecord {
  readonly tree: string;
  readonly commit: string;
  readonly checks: readonly string[];
  readonly passedAt: string;
  readonly node: string;
}

export interface GateDeps {
  /** git in the repo root. */
  readonly git: Git;
  readonly root: string;
  readonly run: (check: LocalCheck) => CheckRun;
  /** A file's text, or undefined when there is none. */
  readonly readText: (path: string) => string | undefined;
  /** Writes a file, creating its folder. */
  readonly writeText: (path: string, text: string) => void;
  readonly now: () => Date;
  /** The Node version the checks ran on, for the record. */
  readonly node: string;
  readonly out: (line: string) => void;
}

export type Verdict = { readonly passed: true } | { readonly passed: false; readonly reason: string };

const PASSED: Verdict = { passed: true };
const ZERO_SHA = /^0+$/;

const short = (sha: string): string => sha.slice(0, 7);
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const firstLines = (text: string): string => text.split('\n').slice(0, 3).join('; ');

async function gitLine(git: Git, args: readonly string[]): Promise<string> {
  return (await git.text(args)).trim();
}

/** Where the pass record of a tree lives: `<git common dir>/local-ci/<tree>.json`. */
export function recordPath(root: string, gitCommonDir: string, tree: string): string {
  return join(resolve(root, gitCommonDir), 'local-ci', `${tree}.json`);
}

/** The record in a file's text, or undefined when there is none, it does not parse, or it proves another tree. */
export function parseRecord(text: string | undefined, tree: string): PassRecord | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { commit, checks, passedAt, node } = value;
  if (value['tree'] !== tree || typeof commit !== 'string' || typeof passedAt !== 'string' || typeof node !== 'string') return undefined;
  if (!Array.isArray(checks) || !checks.every((name): name is string => typeof name === 'string')) return undefined;
  return { tree, commit, checks, passedAt, node };
}

async function recordFile(deps: GateDeps, tree: string): Promise<string> {
  return recordPath(deps.root, await gitLine(deps.git, ['rev-parse', '--git-common-dir']), tree);
}

/**
 * Proves the tree checked out in the repo root: refuses uncommitted changes, reuses the tree's pass record,
 * else runs every check in order, stopping at the first failure with its output, refuses when the checks
 * changed the checkout, and records the pass.
 */
export async function proveHead(checks: readonly LocalCheck[], deps: GateDeps): Promise<Verdict> {
  const status = await deps.git.text(['status', '--porcelain']);
  if (status.trim() !== '') return { passed: false, reason: `the checkout has uncommitted changes (${firstLines(status.trim())}): commit or stash them, the checks prove a committed tree` };
  const tree = await gitLine(deps.git, ['rev-parse', 'HEAD^{tree}']);
  const commit = await gitLine(deps.git, ['rev-parse', 'HEAD']);
  const path = await recordFile(deps, tree);
  const earlier = parseRecord(deps.readText(path), tree);
  if (earlier !== undefined) {
    deps.out(`local checks: passed earlier on tree ${short(tree)} (commit ${short(earlier.commit)}, ${earlier.passedAt}, ${earlier.checks.length} check(s))`);
    return PASSED;
  }
  if (checks.length === 0) return { passed: false, reason: 'no checks are listed: nothing would prove the tree' };

  for (const check of checks) {
    const result = deps.run(check);
    if (result.status !== 0) {
      deps.out(`FAIL: ${check.name} (exit ${result.status ?? 'none: it did not start or was killed'}, ${seconds(result.ms)})`);
      deps.out(result.output.trimEnd());
      return { passed: false, reason: `${check.name} failed on tree ${short(tree)}` };
    }
    deps.out(`pass: ${check.name} (${seconds(result.ms)})`);
  }

  const statusAfter = (await deps.git.text(['status', '--porcelain'])).trim();
  const treeAfter = await gitLine(deps.git, ['rev-parse', 'HEAD^{tree}']);
  if (statusAfter !== '' || treeAfter !== tree) {
    const what = statusAfter !== '' ? firstLines(statusAfter) : `HEAD now holds tree ${short(treeAfter)}`;
    return { passed: false, reason: `the checks left the checkout changed (${what}): a generated file differs from the committed one, commit it and push again` };
  }
  const record: PassRecord = { tree, commit, checks: checks.map((check) => check.name), passedAt: deps.now().toISOString(), node: deps.node };
  deps.writeText(path, `${JSON.stringify(record, null, 2)}\n`);
  deps.out(`local checks: ${checks.length} passed on tree ${short(tree)}, recorded in ${path}`);
  return PASSED;
}

/** One line git gives a pre-push hook on stdin. */
export interface PushUpdate {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
}

/** The updates in a pre-push hook's stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line). */
export function parsePushUpdates(text: string): PushUpdate[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const fields = line.split(/\s+/);
      const [localRef, localSha, remoteRef] = fields;
      if (fields.length !== 4 || localRef === undefined || localSha === undefined || remoteRef === undefined) {
        throw new Error(`pre-push: unexpected line from git: ${line}`);
      }
      return { localRef, localSha, remoteRef };
    });
}

/**
 * Proves each commit a push sends: a deletion sends none; a commit whose tree has a pass record passes; the
 * commit checked out runs the checks; any other commit is refused, since the checks run on the checkout.
 */
export async function provePush(updates: readonly PushUpdate[], checks: readonly LocalCheck[], deps: GateDeps): Promise<Verdict> {
  if (updates.length === 0) {
    deps.out('local checks: nothing to push');
    return PASSED;
  }
  const head = await gitLine(deps.git, ['rev-parse', 'HEAD']);
  for (const update of updates) {
    if (ZERO_SHA.test(update.localSha)) {
      deps.out(`local checks: ${update.remoteRef} is deleted, nothing to check`);
      continue;
    }
    const tree = await gitLine(deps.git, ['rev-parse', `${update.localSha}^{tree}`]);
    const earlier = parseRecord(deps.readText(await recordFile(deps, tree)), tree);
    if (earlier !== undefined) {
      deps.out(`local checks: ${update.localRef} (tree ${short(tree)}) passed earlier (${earlier.passedAt}, ${earlier.checks.length} check(s))`);
      continue;
    }
    if (update.localSha !== head) {
      return { passed: false, reason: `${update.localRef} is at ${short(update.localSha)}, but the checkout has ${short(head)} and the checks run on the checkout: check out ${update.localRef} and push again` };
    }
    const verdict = await proveHead(checks, deps);
    if (!verdict.passed) return verdict;
  }
  return PASSED;
}

/** The environment a check runs in: the caller's, without the GIT_* variables a git hook sets, which would point a check's own git calls at this repo. */
export function checkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_/i.test(name) && name !== 'NODE_TEST_CONTEXT'));
}

/** An environment whose home and Claude config folder are the given empty folder. */
export function isolatedEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Runs checks as child processes from the repo root, capturing their output. */
export function spawnChecks(root: string, env: NodeJS.ProcessEnv): (check: LocalCheck) => CheckRun {
  return (check) => {
    const home = check.isolatedHome === true ? mkdtempSync(join(tmpdir(), 'teamrig-local-home-')) : undefined;
    try {
      if (home !== undefined) mkdirSync(join(home, '.claude'));
      const [program, ...args] = check.argv;
      const started = Date.now();
      const result = spawnSync(program === 'node' ? process.execPath : program, args, {
        cwd: check.cwd === undefined ? root : join(root, check.cwd),
        env: home === undefined ? env : isolatedEnv(env, home),
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      const failed = result.error === undefined ? '' : `${program} did not start: ${result.error.message}\n`;
      return { status: result.error === undefined ? result.status : null, output: `${failed}${result.stdout ?? ''}${result.stderr ?? ''}`, ms: Date.now() - started };
    } finally {
      if (home !== undefined) rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Writes a file, creating its folder. */
export function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** What the gate uses on this machine: git in the repo root, files on disk, checks as child processes of this Node. */
export function machineDeps(root: string, env: NodeJS.ProcessEnv, out: (line: string) => void): GateDeps {
  return {
    git: createGit(root),
    root,
    run: spawnChecks(root, checkEnv(env)),
    readText: readTextIfPresent,
    writeText: writeTextFile,
    now: () => new Date(),
    node: process.version,
    out,
  };
}
