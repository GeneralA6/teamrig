import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, test } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { type SyncDeps, type SyncOptions, syncToMain } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

const TIP = '9f0e1d2c3b4a59687766554433221100ffeeddcc';
const BASE = '1234567890abcdef1234567890abcdef12345678';
/** The branch's commit before the sync, and the stash commit the plan is set aside as. */
const HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';
const SAVED = '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const JSON_PATH = 'plugins/teamrig/.claude-plugin/plugin.json';
const KIT_PATH = 'src/core/version.ts';
const OPTIONS: SyncOptions = { main: 'main', files: TEAMRIG_VERSION_FILES, generated: ['plugins/teamrig/dist'] };

const pluginJson = (version: string): string => `{\n  "name": "teamrig",\n  "version": "${version}"\n}\n`;
const kitVersion = (version: string): string => `export const KIT_VERSION = '${version}';\n`;

type Answer = string | Error | (() => string);

interface Scene {
  /** origin/main's tip, and the merge base of HEAD with it (the tip itself when HEAD contains it). */
  readonly mergeBase?: string;
  readonly baseVersion?: string;
  readonly committedVersion?: string;
  readonly tipVersion?: string;
  /** The version in the working tree's files: the change's uncommitted raise. */
  readonly setVersion?: string;
  /** Answers for git calls this scene changes, keyed by the call's arguments joined with spaces. */
  readonly answers?: Readonly<Record<string, Answer>>;
}

/** A repo dir: git answered from a script of calls, the version files held in memory. */
function sceneDeps(scene: Scene): { deps: SyncDeps; calls: string[]; files: Map<string, string>; logged: string[] } {
  const { mergeBase = BASE, baseVersion = '0.88.0', committedVersion = baseVersion, tipVersion = '0.89.0', setVersion = '0.88.1' } = scene;
  const files = new Map([
    [JSON_PATH, pluginJson(setVersion)],
    [KIT_PATH, kitVersion(setVersion)],
  ]);
  const answers: Record<string, Answer> = {
    'fetch --quiet origin main': '',
    'rev-parse refs/remotes/origin/main': TIP,
    [`merge-base HEAD ${TIP}`]: mergeBase,
    [`show HEAD:${JSON_PATH}`]: pluginJson(committedVersion),
    [`show ${BASE}:${JSON_PATH}`]: pluginJson(baseVersion),
    [`show ${TIP}:${JSON_PATH}`]: pluginJson(tipVersion),
    [`diff --numstat HEAD -- ${JSON_PATH}`]: setVersion === committedVersion ? '' : `1\t1\t${JSON_PATH}`,
    [`diff --numstat HEAD -- ${KIT_PATH}`]: setVersion === committedVersion ? '' : `1\t1\t${KIT_PATH}`,
    [`checkout -- ${JSON_PATH} ${KIT_PATH}`]: () => {
      files.set(JSON_PATH, pluginJson(committedVersion));
      files.set(KIT_PATH, kitVersion(committedVersion));
      return '';
    },
    'rev-parse HEAD': HEAD,
    'status --porcelain --untracked-files=no': ' M docs/guide.md',
    'stash create ship.ts: the plan, set aside for the rebase onto main': SAVED,
    'reset --hard --quiet': '',
    [`rebase --quiet ${TIP}`]: '',
    [`stash apply --quiet ${SAVED}`]: '',
    [`reset --hard --quiet ${HEAD}`]: '',
    [`diff --unified=0 ${TIP} -- . :(exclude)${JSON_PATH} :(exclude)${KIT_PATH} :(exclude)plugins/teamrig/dist`]: '+++ b/docs/guide.md\n+Since the next version, a ship rebases.',
    ...scene.answers,
  };
  const calls: string[] = [];
  const logged: string[] = [];
  const git = (...args: string[]): string => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected git ${key}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  };
  const deps: SyncDeps = {
    git,
    readText: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeText: (path, text) => {
      files.set(path, text);
    },
    log: (line) => logged.push(line),
  };
  return { deps, calls, files, logged };
}

test('a branch that already contains main\'s tip is left as it is', () => {
  const { deps, calls, files } = sceneDeps({ mergeBase: TIP });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'current', sets: '0.88.1' });
  assert.deepEqual(calls, ['fetch --quiet origin main', 'rev-parse refs/remotes/origin/main', `merge-base HEAD ${TIP}`]);
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.1'));
});

test('rebases onto the moved main with the plan set aside, then sets the change\'s patch raise on main\'s version', () => {
  const { deps, calls, files, logged } = sceneDeps({});
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, sets: '0.89.1' });
  assert.equal(files.get(JSON_PATH), pluginJson('0.89.1'));
  assert.equal(files.get(KIT_PATH), kitVersion('0.89.1'));
  const order = ['checkout', 'stash create', 'reset --hard --quiet', 'rebase', 'stash apply'].map((verb) => calls.findIndex((call) => call.startsWith(verb)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(logged, [
    'origin/main moved to 9f0e1d2 since the branch was cut: rebasing onto it',
    `set the plan's uncommitted changes aside as ${SAVED} (git stash apply ${SAVED} brings them back)`,
    'version 0.88.1 -> 0.89.1: origin/main is at 0.89.0, the change raises its patch',
  ]);
});

test('never pushes on or pops from the stash list, which every worktree of the clone shares', () => {
  const { deps, calls } = sceneDeps({});
  syncToMain(deps, OPTIONS);
  assert.deepEqual(calls.filter((call) => call.startsWith('stash')), ['stash create ship.ts: the plan, set aside for the rebase onto main', `stash apply --quiet ${SAVED}`]);
});

test('a minor raise stays a minor raise on main\'s version', () => {
  const { deps, files } = sceneDeps({ setVersion: '0.89.0', tipVersion: '0.89.2' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, sets: '0.90.0' });
  assert.equal(files.get(KIT_PATH), kitVersion('0.90.0'));
});

test('skips the stash when the plan has no uncommitted change besides the version', () => {
  const { deps, calls } = sceneDeps({ answers: { 'status --porcelain --untracked-files=no': '' } });
  assert.equal(syncToMain(deps, OPTIONS).kind, 'rebased');
  assert.ok(!calls.some((call) => call.startsWith('stash')));
});

test('a change that does not raise the version is rebased and its files left alone', () => {
  const { deps, calls, files } = sceneDeps({ setVersion: '0.88.0' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, sets: '0.88.0' });
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.0'));
  assert.ok(!calls.some((call) => call.startsWith('diff --unified')));
});

test('main that moved without a raise of its own keeps the change\'s version, with no search for the old one', () => {
  const { deps, calls } = sceneDeps({ tipVersion: '0.88.0' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, sets: '0.88.1' });
  assert.ok(!calls.some((call) => call.startsWith('diff --unified')));
});

test('refuses a change that names its old version outside the version files, naming each file', () => {
  const diff = `+++ b/docs/guide.md\n+Since 0.88.1, a tab runs its own teamrig.\n+++ b/README.md\n+Needs teamrig 0.88.12.\n+++ b/SKILL.md\n-was 0.88.1\n+(0.88.1)`;
  const { deps } = sceneDeps({ answers: { [`diff --unified=0 ${TIP} -- . :(exclude)${JSON_PATH} :(exclude)${KIT_PATH} :(exclude)plugins/teamrig/dist`]: diff } });
  assert.throws(() => syncToMain(deps, OPTIONS), /^Error: REFUSED the change names its old version 0\.88\.1 in docs\/guide\.md, SKILL\.md: set it to 0\.89\.1 there, then ship again$/);
});

test('refuses a raise committed in the branch before touching the work', () => {
  const { deps, calls } = sceneDeps({ committedVersion: '0.88.1' });
  assert.throws(() => syncToMain(deps, OPTIONS), /REFUSED a commit of the branch raises the version in plugins\/teamrig\/\.claude-plugin\/plugin\.json: leave the raise uncommitted/);
  assert.ok(!calls.some((call) => call.startsWith('checkout') || call.startsWith('stash') || call.startsWith('rebase')));
});

test('refuses a version file with other uncommitted changes before touching the work', () => {
  const { deps, calls } = sceneDeps({ answers: { [`diff --numstat HEAD -- ${KIT_PATH}`]: `4\t1\t${KIT_PATH}` } });
  assert.throws(() => syncToMain(deps, OPTIONS), /REFUSED src\/core\/version\.ts has uncommitted changes besides its version/);
  assert.ok(!calls.some((call) => call.startsWith('checkout')));
});

test('a conflicting rebase is aborted and the plan and its version raise are put back', () => {
  const { deps, calls, files } = sceneDeps({ answers: { [`rebase --quiet ${TIP}`]: new Error('CONFLICT (content): Merge conflict in src/a.ts'), 'rebase --abort': '' } });
  assert.throws(
    () => syncToMain(deps, OPTIONS),
    /REFUSED rebasing onto origin\/main 9f0e1d2 conflicts: rebase by hand, then ship again; the branch and the plan are as they were before the ship$/,
  );
  assert.deepEqual(calls.slice(-4), [`rebase --quiet ${TIP}`, 'rebase --abort', `reset --hard --quiet ${HEAD}`, `stash apply --quiet ${SAVED}`]);
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.1'));
  assert.equal(files.get(KIT_PATH), kitVersion('0.88.1'));
});

/** `stash apply` of the plan: the first call fails as a conflict, later ones answer `later`. */
const applyConflicts = (later: Answer): Answer => {
  let applies = 0;
  return () => {
    applies += 1;
    if (applies === 1) throw new Error('CONFLICT (content): Merge conflict in docs/guide.md');
    if (later instanceof Error) throw later;
    return typeof later === 'function' ? later() : later;
  };
};

test('a plan that conflicts with the moved main puts the branch back where it was and the plan on it, leaving no stash entry (T2696)', () => {
  const { deps, calls, files } = sceneDeps({ answers: { [`stash apply --quiet ${SAVED}`]: applyConflicts('') } });
  assert.throws(
    () => syncToMain(deps, OPTIONS),
    /^Error: REFUSED the plan's uncommitted changes conflict with origin\/main 9f0e1d2: rebase by hand and resolve the conflict, then ship again; the branch and the plan are as they were before the ship$/,
  );
  assert.deepEqual(calls.slice(-3), [`stash apply --quiet ${SAVED}`, `reset --hard --quiet ${HEAD}`, `stash apply --quiet ${SAVED}`]);
  assert.ok(!calls.some((call) => call.startsWith('stash push') || call.startsWith('stash pop')));
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.1'));
  assert.equal(files.get(KIT_PATH), kitVersion('0.88.1'));
});

test('when even putting the plan back fails, the refusal names the commit that holds it', () => {
  const { deps } = sceneDeps({ answers: { [`stash apply --quiet ${SAVED}`]: applyConflicts(new Error('error: could not apply')) } });
  assert.throws(() => syncToMain(deps, OPTIONS), new RegExp(`; putting the plan back failed too: git stash apply ${SAVED} restores it$`));
});

/**
 * A real clone: main holds the version files, a guide and a built dist; the branch `change` adds src/a.ts; then main
 * moves, changing the guide and the dist. origin is the repo itself, so `fetch origin main` reads its own main.
 */
function movedClone(): { repo: TempRepo; head: string; deps: SyncDeps } {
  const repo = new TempRepo('sync').init();
  const files: Record<string, string> = { [JSON_PATH]: pluginJson('0.88.0'), [KIT_PATH]: kitVersion('0.88.0'), 'docs/guide.md': 'one\n', 'plugins/teamrig/dist/teamrig.js': 'a\n' };
  for (const [path, text] of Object.entries(files)) repo.write(path, text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'base');
  repo.git('branch', '-M', 'main');
  repo.git('remote', 'add', 'origin', '.');
  repo.git('checkout', '-q', '-b', 'change');
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'core: a');
  repo.git('checkout', '-q', 'main');
  repo.write('docs/guide.md', 'two\n');
  repo.write('plugins/teamrig/dist/teamrig.js', 'b\n');
  repo.git('commit', '-q', '-am', 'docs: two');
  repo.git('checkout', '-q', 'change');
  const head = repo.git('rev-parse', 'HEAD').trim();
  // The plan's raise, and a dist an earlier run built and took back.
  repo.write(JSON_PATH, pluginJson('0.88.1'));
  repo.write(KIT_PATH, kitVersion('0.88.1'));
  repo.write('plugins/teamrig/dist/teamrig.js', 'c\n');
  repo.write('plugins/teamrig/dist/new.js', 'new\n');
  const deps: SyncDeps = {
    git: (...args) => repo.git(...args).trim(),
    readText: (path) => readFileSync(join(repo.dir, path), 'utf8'),
    writeText: (path, text) => repo.write(path, text),
    log: () => undefined,
  };
  return { repo, head, deps };
}

describe('on a real clone', () => {
  let repo: TempRepo | null = null;
  afterEach(() => repo?.remove());

  it('a plan that conflicts with the moved main leaves no stash entry, the branch where it was and the plan on it (T2696)', () => {
    const clone = movedClone();
    repo = clone.repo;
    clone.repo.write('docs/guide.md', 'mine\n');
    assert.throws(() => syncToMain(clone.deps, OPTIONS), /REFUSED the plan's uncommitted changes conflict with origin\/main/);
    assert.equal(clone.repo.git('stash', 'list'), '');
    assert.equal(clone.repo.git('rev-parse', 'HEAD').trim(), clone.head);
    assert.equal(clone.repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'change');
    assert.equal(readFileSync(join(clone.repo.dir, 'docs/guide.md'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(clone.repo.dir, JSON_PATH), 'utf8'), pluginJson('0.88.1'));
  });
});

test('needs at least one version file', () => {
  const { deps } = sceneDeps({});
  assert.throws(() => syncToMain(deps, { ...OPTIONS, files: [] }), /needs at least one version file/);
});
