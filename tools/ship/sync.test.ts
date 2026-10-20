import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SyncDeps, type SyncOptions, syncToMain } from './sync.ts';
import { TEAMRIG_VERSION_FILES } from './version-bump.ts';

const TIP = '9f0e1d2c3b4a59687766554433221100ffeeddcc';
const BASE = '1234567890abcdef1234567890abcdef12345678';
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
    'status --porcelain --untracked-files=no': ' M docs/guide.md',
    'stash push --quiet -m ship.ts: the plan, set aside for the rebase onto main': '',
    [`rebase --quiet ${TIP}`]: '',
    'stash pop --quiet': '',
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
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'current' });
  assert.deepEqual(calls, ['fetch --quiet origin main', 'rev-parse refs/remotes/origin/main', `merge-base HEAD ${TIP}`]);
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.1'));
});

test('rebases onto the moved main with the plan set aside, then sets the change\'s patch raise on main\'s version', () => {
  const { deps, calls, files, logged } = sceneDeps({});
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, version: { from: '0.88.1', to: '0.89.1' } });
  assert.equal(files.get(JSON_PATH), pluginJson('0.89.1'));
  assert.equal(files.get(KIT_PATH), kitVersion('0.89.1'));
  const order = ['checkout', 'stash push', 'rebase', 'stash pop'].map((verb) => calls.findIndex((call) => call.startsWith(verb)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(logged, ['origin/main moved to 9f0e1d2 since the branch was cut: rebasing onto it', 'version 0.88.1 -> 0.89.1: origin/main is at 0.89.0, the change raises its patch']);
});

test('a minor raise stays a minor raise on main\'s version', () => {
  const { deps, files } = sceneDeps({ setVersion: '0.89.0', tipVersion: '0.89.2' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, version: { from: '0.89.0', to: '0.90.0' } });
  assert.equal(files.get(KIT_PATH), kitVersion('0.90.0'));
});

test('skips the stash when the plan has no uncommitted change besides the version', () => {
  const { deps, calls } = sceneDeps({ answers: { 'status --porcelain --untracked-files=no': '' } });
  assert.equal(syncToMain(deps, OPTIONS).kind, 'rebased');
  assert.ok(!calls.some((call) => call.startsWith('stash')));
});

test('a change that does not raise the version is rebased and its files left alone', () => {
  const { deps, calls, files } = sceneDeps({ setVersion: '0.88.0' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, version: null });
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.0'));
  assert.ok(!calls.some((call) => call.startsWith('diff --unified')));
});

test('main that moved without a raise of its own keeps the change\'s version, with no search for the old one', () => {
  const { deps, calls } = sceneDeps({ tipVersion: '0.88.0' });
  assert.deepEqual(syncToMain(deps, OPTIONS), { kind: 'rebased', onto: TIP, version: { from: '0.88.1', to: '0.88.1' } });
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
  assert.throws(() => syncToMain(deps, OPTIONS), /REFUSED rebasing onto origin\/main 9f0e1d2 conflicts: rebase by hand, then ship again/);
  assert.deepEqual(calls.slice(-3), [`rebase --quiet ${TIP}`, 'rebase --abort', 'stash pop --quiet']);
  assert.equal(files.get(JSON_PATH), pluginJson('0.88.1'));
  assert.equal(files.get(KIT_PATH), kitVersion('0.88.1'));
});

test('a plan that conflicts with the moved main is refused and left in the stash', () => {
  const { deps } = sceneDeps({ answers: { 'stash pop --quiet': new Error('CONFLICT (content): Merge conflict in docs/guide.md') } });
  assert.throws(() => syncToMain(deps, OPTIONS), /REFUSED the plan's uncommitted changes conflict with origin\/main 9f0e1d2: they stay in git stash/);
});

test('needs at least one version file', () => {
  const { deps } = sceneDeps({});
  assert.throws(() => syncToMain(deps, { ...OPTIONS, files: [] }), /needs at least one version file/);
});
