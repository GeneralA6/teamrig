import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './json.ts';
import { type LocalCheck, type LocalChecks, type RepoProfile, profileFor, readProfiles, slugOf } from './repos.ts';

/**
 * The local gate: proves that the tree checked out in a repo dir passed every local check, once per tree.
 * The proof is a pass record at `<git common dir>/local-ci/<tree sha>.json`, so every worktree of the repo
 * shares it, written only when every check passed on a clean checkout and the checks left it as they found it:
 *   { "tree": "<sha>", "commit": "<sha>", "checks": ["<name>", ...], "passedAt": "<ISO time>", "node": "<version>" }
 * ship (after its commits), merge (a repo whose gate is local) and the repos' pre-push hook read it first,
 * so a tree is checked once, not at each step. A repo's own runner, once its tree holds one, writes the
 * same record itself.
 */

export interface PassRecord {
  tree: string;
  commit: string;
  checks: string[];
  passedAt: string;
  node: string;
}

export interface CheckRun {
  /** The exit code; null when the command could not start or died by a signal. */
  status: number | null;
  /** stdout, then stderr. */
  output: string;
  ms: number;
}

/** What the gate reaches outside itself, so a test can stand in for each. */
export interface GateDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  git: (...args: string[]) => string;
  exists: (path: string) => boolean;
  /** A file's text, or null when there is none. */
  readText: (path: string) => string | null;
  /** Writes a file, making its folder first. */
  writeText: (path: string, text: string) => void;
  /** Runs one check from the repo dir. */
  run: (check: LocalCheck) => CheckRun;
  now: () => Date;
  log: (line: string) => void;
}

export type GateVerdict = { passed: true; tree: string; record: string; reused: boolean } | { passed: false; reason: string };

/**
 * The checks ship already ran on the content it committed, by their names in repos.json: typecheck and the
 * coverage gate on the working tree before its commits (the gate's clean-tree rule means nothing was left
 * out of them), and the build that made its dist commit.
 */
export const SHIP_RAN_BEFORE: readonly string[] = ['typecheck', 'coverage gate', 'build: clean', 'build: compile'];

const short = (sha: string): string => sha.slice(0, 7);
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export function recordPath(dir: string, gitCommonDir: string, tree: string): string {
  return join(resolve(dir, gitCommonDir), 'local-ci', `${tree}.json`);
}

/** The record a file holds for `tree`; null when there is none, it is not a record, or it is another tree's. */
export function parseRecord(text: string | null, tree: string): PassRecord | null {
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const { tree: recorded, commit, checks, passedAt, node } = body;
  if (recorded !== tree || typeof commit !== 'string' || !isStringList(checks) || typeof passedAt !== 'string' || typeof node !== 'string') return null;
  return { tree, commit, checks, passedAt, node };
}

/** The checks a tree runs: its own runner when it holds one, else the fallback list. */
export function checksFor(dir: string, checks: LocalChecks, exists: GateDeps['exists']): readonly LocalCheck[] {
  if (checks.runner !== null && exists(join(dir, checks.runner))) return [{ name: `runner ${checks.runner}`, run: ['node', checks.runner], cwd: null }];
  return checks.fallback;
}

const firstLines = (status: string): string => {
  const lines = status.split('\n');
  return lines.length > 3 ? `${lines.slice(0, 3).join('; ')}; and ${lines.length - 3} more` : lines.join('; ');
};

/**
 * Proves the repo dir's checked-out tree: its pass record when one exists, else every check run in order
 * (stopping at the first failure, whose full output is logged), then a record. `ranBefore` names checks
 * that already passed on this very content (ship's, before its commits).
 */
export function proveTree(dir: string, checks: LocalChecks, deps: GateDeps, ranBefore: readonly string[] = []): GateVerdict {
  const status = deps.git('status', '--porcelain');
  if (status !== '') return { passed: false, reason: `${dir} has uncommitted changes (${firstLines(status)}): commit or stash them, the checks prove only a committed tree` };
  const tree = deps.git('rev-parse', 'HEAD^{tree}');
  const commit = deps.git('rev-parse', 'HEAD');
  const path = recordPath(dir, deps.git('rev-parse', '--git-common-dir'), tree);
  const earlier = parseRecord(deps.readText(path), tree);
  if (earlier !== null) {
    deps.log(`local checks: passed earlier on tree ${short(tree)} (commit ${short(earlier.commit)}, ${earlier.passedAt}, ${earlier.checks.length} check(s)), skipped`);
    return { passed: true, tree, record: path, reused: true };
  }

  const list = checksFor(dir, checks, deps.exists);
  if (list.length === 0) return { passed: false, reason: 'no local checks are listed for this repo in repos.json: nothing would prove the tree' };
  const before = new Set(ranBefore);
  for (const check of list) {
    if (before.has(check.name)) {
      deps.log(`pass: ${check.name} (before the commits, on this content)`);
      continue;
    }
    const result = deps.run(check);
    if (result.status !== 0) {
      deps.log(`FAIL: ${check.name} (exit ${result.status ?? 'none: it did not start or was killed'}, ${seconds(result.ms)})`);
      deps.log(result.output.trimEnd());
      return { passed: false, reason: `${check.name} failed on tree ${short(tree)}` };
    }
    deps.log(`pass: ${check.name} (${seconds(result.ms)})`);
  }

  const statusAfter = deps.git('status', '--porcelain');
  const treeAfter = deps.git('rev-parse', 'HEAD^{tree}');
  if (statusAfter !== '' || treeAfter !== tree) {
    const what = statusAfter !== '' ? firstLines(statusAfter) : `HEAD now holds tree ${short(treeAfter)}`;
    return { passed: false, reason: `the checks left ${dir} changed (${what}): a generated file differs from the committed one` };
  }
  if (parseRecord(deps.readText(path), tree) === null) {
    const record: PassRecord = { tree, commit, checks: list.map(check => check.name), passedAt: deps.now().toISOString(), node: process.version };
    deps.writeText(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  deps.log(`local checks: ${list.length} passed on tree ${short(tree)}, recorded in ${path}`);
  return { passed: true, tree, record: path, reused: false };
}

export const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

/** The file and arguments a check spawns: a leading `node` is this node, `{skill}` this skill's folder. */
export function commandOf(run: readonly string[], skillDir: string = SKILL_DIR, nodePath: string = process.execPath): { file: string; args: string[] } {
  const [first = '', ...rest] = run.map(arg => arg.replaceAll('{skill}', skillDir));
  return first === 'node' ? { file: nodePath, args: ['--disable-warning=ExperimentalWarning', ...rest] } : { file: first, args: rest };
}

/** The real git, files and processes for a repo dir. */
export function realGateDeps(dir: string, log: (line: string) => void): GateDeps {
  return {
    git: (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(),
    exists: path => existsSync(path),
    readText: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    writeText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    run: check => {
      const { file, args } = commandOf(check.run);
      const started = Date.now();
      const result = spawnSync(file, args, { cwd: join(dir, check.cwd ?? '.'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
      const output = [result.stdout ?? '', result.stderr ?? '', result.error === undefined ? '' : result.error.message].filter(part => part !== '').join('\n');
      return { status: result.status, output, ms: Date.now() - started };
    },
    now: () => new Date(),
    log,
  };
}

/** What `ship.ts check` reaches outside itself. */
export interface CheckCommandDeps {
  profiles: ReadonlyMap<string, RepoProfile>;
  gate: GateDeps;
  err: (line: string) => void;
}

const realCheckDeps = (dir: string): CheckCommandDeps => ({
  profiles: readProfiles(),
  gate: realGateDeps(dir, line => console.log(line)),
  err: line => console.error(line),
});

/**
 * `ship.ts check <repo dir>`: proves the dir's checked-out tree with the local checks repos.json lists for
 * its origin (a pass record, else a run that writes one), whatever the repo's merge gate. Exit 0 on a pass.
 */
export function checkCommand(argv: readonly string[], depsFor: (dir: string) => CheckCommandDeps = realCheckDeps): number {
  const [dir, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--') || rest.length > 0) {
    console.error('usage: ship.ts check <repo dir>');
    return 1;
  }
  const deps = depsFor(dir);
  try {
    const profile = profileFor(deps.profiles, slugOf(deps.gate.git('remote', 'get-url', 'origin')));
    const verdict = proveTree(dir, profile.local, deps.gate);
    if (verdict.passed) return 0;
    deps.err(`REFUSED ${verdict.reason}`);
    return 1;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
