import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catchUp, ownDiff, type CatchUpDeps, type CatchUpRequest } from './catch-up.ts';
import { TEAMRIG_REGENERATION, listedPaths, regenerationFor, workPathspec } from './regenerate.ts';
import { profileFor, readProfiles } from './repos.ts';

const HEAD = 't9-change';
const NEXT = 't9-change-2';
const SHA = 'abc1234def';
const BASE = 'base000aaa';
const TIP = 'moved00bbb';
const REBASED = 'rebased0ccc';
const REQUEST: CatchUpRequest = { head: HEAD, stem: HEAD, tip: TIP, main: 'main', regenerated: [] };

/** A repo with nothing regenerated writes no file and builds nothing. */
const NO_REGENERATION = {
  readText: (path: string): string => {
    throw new Error(`unexpected read of ${path}`);
  },
  writeText: (path: string): void => {
    throw new Error(`unexpected write of ${path}`);
  },
  build: (): void => {
    throw new Error('unexpected build');
  },
};

const DIFF_AT_BASE = ['diff --git a/src/a.ts b/src/a.ts', 'index 1111111..2222222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10 +10,2 @@ export function a() {', '-old', '+new', '+more'].join('\n');
/** The same change on the moved main: other blob ids, its lines further down. */
const DIFF_ON_TIP = DIFF_AT_BASE.replace('index 1111111..2222222', 'index 3333333..4444444').replace('@@ -10 +10,2 @@', '@@ -14 +14,2 @@');

interface Fixture {
  checkedOut?: string;
  status?: string;
  rebase?: 'clean' | 'conflict';
  diffOnTip?: string;
  push?: Error;
  /** Where main is on origin when it is read again after a failed push: TIP (unmoved) unless given. */
  movedTo?: string;
}

/** git in a repo dir whose `HEAD` main moved past; every call is kept, and one it does not expect throws. */
function fakeGit(fixture: Fixture = {}): { git: (...args: string[]) => string; calls: string[] } {
  const calls: string[] = [];
  const diff = (from: string, to: string): string => ['diff', '--unified=3', '--no-color', '--no-ext-diff', '--no-renames', from, to].join(' ');
  const answers: Record<string, string> = {
    [`rev-parse refs/heads/${HEAD}`]: SHA,
    'rev-parse --abbrev-ref HEAD': fixture.checkedOut ?? HEAD,
    'status --porcelain': fixture.status ?? '',
    [`merge-base ${SHA} ${TIP}`]: BASE,
    [diff(BASE, SHA)]: DIFF_AT_BASE,
    'rebase --abort': '',
    'rev-parse HEAD': REBASED,
    [diff(TIP, REBASED)]: fixture.diffOnTip ?? DIFF_ON_TIP,
    'fetch --quiet origin main': '',
    'rev-parse refs/remotes/origin/main': fixture.movedTo ?? TIP,
    // The caught-up head sits on TIP, so it contains TIP and no later tip.
    [`merge-base HEAD ${fixture.movedTo ?? TIP}`]: TIP,
  };
  let branch = fixture.checkedOut ?? HEAD;
  const git = (...args: string[]): string => {
    const key = args.join(' ');
    calls.push(key);
    if (key === `rebase --quiet ${TIP}` && fixture.rebase !== 'conflict') return '';
    if (key === `rebase --quiet ${TIP}`) throw new Error('CONFLICT (content): Merge conflict in src/a.ts');
    if (key.startsWith('push ') && fixture.push !== undefined) throw fixture.push;
    if (key === 'rev-parse --abbrev-ref HEAD') return branch;
    if (key.startsWith('switch ')) {
      branch = args.at(-1) ?? branch;
      return '';
    }
    // No branch by any new name yet, here or on origin; pushing or deleting one says nothing.
    if (['branch --list ', 'ls-remote --heads origin ', 'push --quiet origin ', 'branch --quiet --delete --force '].some((prefix) => key.startsWith(prefix))) return '';
    const answer = answers[key];
    if (answer === undefined) throw new Error(`unexpected git ${key}`);
    return answer;
  };
  return { git, calls };
}

test('the same change on a newer main has the same own diff; a changed line does not', () => {
  const { git } = fakeGit();
  assert.equal(ownDiff(git, BASE, SHA), ownDiff(git, TIP, REBASED));
  const changed = fakeGit({ diffOnTip: DIFF_ON_TIP.replace('+more', '+other') });
  assert.notEqual(ownDiff(changed.git, BASE, SHA), ownDiff(changed.git, TIP, REBASED));
  const moved = fakeGit({ diffOnTip: DIFF_ON_TIP.replace('@@ -14 +14,2 @@ export function a() {', '@@ -14 +14,2 @@ export function b() {') });
  assert.notEqual(ownDiff(moved.git, BASE, SHA), ownDiff(moved.git, TIP, REBASED), 'the same lines in another function are another change');
});

test('a head main moved past rebases cleanly onto its tip as <stem>-2, keeps its diff, and is pushed under that name (T2809)', () => {
  const { git, calls } = fakeGit();
  const log: string[] = [];
  assert.deepEqual(catchUp({ ...NO_REGENERATION, git, log: (line) => log.push(line) }, REQUEST), { kind: 'rebased', head: NEXT, sha: REBASED });
  assert.ok(calls.indexOf(`switch --quiet --create ${NEXT}`) < calls.indexOf(`rebase --quiet ${TIP}`), 'the pushed head itself is never rewritten');
  assert.equal(calls.at(-1), `push --quiet origin HEAD:refs/heads/${NEXT}`);
  assert.ok(!calls.some((call) => call.includes('--force')), 'a new name needs no force');
  assert.deepEqual(log, [`main moved to moved00, which ${HEAD} abc1234 does not contain: rebased it cleanly with the same diff and pushed it as ${NEXT} rebased; merging that`]);
});

test('numbers a later head from the stem the merge began with', () => {
  const { git, calls } = fakeGit();
  catchUp({ ...NO_REGENERATION, git, log: () => undefined }, { ...REQUEST, stem: 't9' });
  assert.ok(calls.includes('branch --list t9-2'));
});

/** The calls that put the repo dir back as it was, after a rebase as NEXT was tried. */
const RESTORED = [`switch --quiet ${HEAD}`, `branch --quiet --delete --force ${NEXT}`];

test('a conflicting rebase is aborted and refused, with the head checked out again and no new branch left', () => {
  const { git, calls } = fakeGit({ rebase: 'conflict' });
  const result = catchUp({ ...NO_REGENERATION, git, log: () => undefined }, REQUEST);
  assert.equal(result.kind, 'refused');
  assert.match(result.kind === 'refused' ? result.reason : '', /^main moved to moved00, which t9-change abc1234 does not contain, and rebasing it onto that tip conflicts: rebase it by hand/);
  assert.deepEqual(calls.slice(-3), ['rebase --abort', ...RESTORED]);
  assert.ok(!calls.some((call) => call.startsWith('push')));
});

test('a clean rebase whose diff changed is refused and never pushed', () => {
  const { git, calls } = fakeGit({ diffOnTip: DIFF_ON_TIP.replace('+more', '+other') });
  const result = catchUp({ ...NO_REGENERATION, git, log: () => undefined }, REQUEST);
  assert.match(result.kind === 'refused' ? result.reason : '', /, and its diff changes when rebased onto that tip: rebase it by hand, check it/);
  assert.deepEqual(calls.slice(-2), RESTORED);
  assert.ok(!calls.some((call) => call.startsWith('push')));
});

test('a failed push is refused with its error, the repo dir back on the head', () => {
  const { git, calls } = fakeGit({ push: new Error('pre-push: the local gate failed') });
  const result = catchUp({ ...NO_REGENERATION, git, log: () => undefined }, REQUEST);
  assert.match(result.kind === 'refused' ? result.reason : '', /, and pushing it rebased as t9-change-2 failed: pre-push: the local gate failed$/);
  assert.ok(calls.includes(`merge-base HEAD ${TIP}`), 'main was read again and had not moved');
  assert.deepEqual(calls.slice(-2), RESTORED);
});

test('a failed push while main moved again comes back as moved, with the new tip, the repo dir back on the head (T4131)', () => {
  const AGAIN = 'again00ddd';
  const { git, calls } = fakeGit({ push: new Error('pre-push: the plugin version 0.2.1 is already on main'), movedTo: AGAIN });
  const log: string[] = [];
  const result = catchUp({ ...NO_REGENERATION, git, log: (line) => log.push(line) }, REQUEST);
  assert.equal(result.kind, 'moved');
  assert.equal(result.kind === 'moved' ? result.tip : '', AGAIN);
  assert.match(result.kind === 'moved' ? result.reason : '', /^t9-change abc1234 was caught up, and main moved again to again00 while it was pushed rebased as t9-change-2, and that push failed: pre-push: the plugin version 0\.2\.1 is already on main$/);
  assert.ok(calls.indexOf(`merge-base HEAD ${AGAIN}`) < calls.indexOf(`switch --quiet ${HEAD}`), 'main is read against the caught-up head, before it is dropped');
  assert.deepEqual(calls.slice(-2), RESTORED);
  assert.match(log.at(-1) ?? '', /: catching it up again$/);
});

test('a head not checked out, or a repo dir with uncommitted changes, is refused before any branch or rebase', () => {
  for (const [fixture, why] of [
    [{ checkedOut: 'other' }, /, and it is not checked out in the repo dir to be rebased there/],
    [{ status: ' M src/a.ts' }, /, and the repo dir has uncommitted changes/],
  ] as const) {
    const { git, calls } = fakeGit(fixture);
    const result = catchUp({ ...NO_REGENERATION, git, log: () => undefined }, REQUEST);
    assert.match(result.kind === 'refused' ? result.reason : '', why);
    assert.ok(!calls.some((call) => call.startsWith('switch') || call.startsWith('rebase')));
  }
});

test("a main edit within git's 3 context lines of the change changes its own diff; one further away does not (the security review's F1)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catch-up-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const filler = Array.from({ length: 6 }, (_, at) => `// line ${at}`);
  const write = (lines: readonly string[]): void => writeFileSync(join(dir, 'guard.ts'), `${lines.join('\n')}\n`);
  const commit = (lines: readonly string[]): string => {
    write(lines);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x');
    return git('rev-parse', 'HEAD');
  };
  const BASE_LINES = ['export function check(cmd) {', '  const c = parse(cmd);', '  log(c);', '  return allow();', '}', ...filler, 'export const far = 1;'];
  git('init', '-q');
  const base = commit(BASE_LINES);
  const change = commit(BASE_LINES.flatMap((line) => (line === '  log(c);' ? [line, '  if (isForce(c)) return deny();'] : [line])));
  const own = ownDiff(git, base, change);
  const onMain = (from: string, to: string): string => {
    git('checkout', '-q', base);
    const tip = commit(BASE_LINES.map((line) => (line === from ? to : line)));
    git('checkout', '-q', change);
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'rebase', '-q', tip);
    return ownDiff(git, tip, git('rev-parse', 'HEAD'));
  };
  assert.notEqual(onMain('  const c = parse(cmd);', '  const c = parse(cmd).slice(1);'), own, 'the added check now tests another value');
  assert.equal(onMain('export const far = 1;', 'export const far = 2;'), own);
});

test('regenerationFor makes teamrig\'s version files and dist again only for exactly that list (T2988)', () => {
  assert.equal(regenerationFor(listedPaths(TEAMRIG_REGENERATION)), TEAMRIG_REGENERATION);
  assert.equal(regenerationFor([...listedPaths(TEAMRIG_REGENERATION)].reverse()), TEAMRIG_REGENERATION);
  assert.equal(regenerationFor(profileFor(readProfiles(), 'GeneralA6/teamrig').regenerated), TEAMRIG_REGENERATION, 'the shipped repos.json');
  assert.equal(regenerationFor(profileFor(readProfiles(), 'GeneralA6/teamrig-pane').regenerated), null, 'teamrig-pane raises its plugin.json by hand');
  assert.equal(regenerationFor([]), null);
  assert.equal(regenerationFor(['plugins/teamrig/dist/', 'src/core/version.ts']), null);
});

const PLUGIN = 'plugins/teamrig/.claude-plugin/plugin.json';
const KIT = 'src/core/version.ts';

/**
 * A teamrig-like repo and its bare origin: plugin.json and version.ts carry the version, and the "build" writes one
 * dist file per src file. main and the change each raise the version from the same base, with the dist rebuilt.
 */
function teamrigRepo(t: { after: (fn: () => void) => void }): { dir: string; git: (...args: string[]) => string; build: () => void; commitFiles: (files: Readonly<Record<string, string>>, message: string) => string; raise: (version: string, message: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'catch-up-regen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')]);
  mkdirSync(dir);
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(root, 'no-hooks')], ['core.autocrlf', 'false']] as const) git('config', key, value);
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  const write = (path: string, text: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const build = (): void => {
    for (const name of readdirSync(join(dir, 'src')).filter((file) => file.endsWith('.ts'))) write(`plugins/teamrig/dist/${name.replace(/\.ts$/, '.js')}`, `// built\n${readFileSync(join(dir, 'src', name), 'utf8')}`);
  };
  const commitFiles = (files: Readonly<Record<string, string>>, message: string): string => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('commit', '-q', '-s', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const raise = (version: string, message: string): string => {
    commitFiles({ [PLUGIN]: `{\n  "name": "teamrig",\n  "version": "${version}"\n}\n`, [KIT]: `export const KIT_VERSION = '${version}';\n` }, message);
    build();
    return commitFiles({}, 'build: rebuild the plugin dist');
  };
  commitFiles({ 'src/a.ts': 'export const a = 1;\n', [KIT]: "export const KIT_VERSION = '0.1.0';\n", [PLUGIN]: '{\n  "name": "teamrig",\n  "version": "0.1.0"\n}\n', 'README.md': '# r\n' }, 'base');
  build();
  commitFiles({}, 'build: the first dist');
  return { dir, git, build, commitFiles, raise };
}

/** main moved to 0.2.0 with its own work (a new src/b.ts) and dist; the change, from the base, sits on HEAD (t9-change) at 0.1.1. */
function movedPast(t: { after: (fn: () => void) => void }, work: Readonly<Record<string, string>> = { 'src/a.ts': 'export const a = 2;\n' }, mainWork: Readonly<Record<string, string>> = { 'src/b.ts': 'export const b = 1;\n' }) {
  const repo = teamrigRepo(t);
  const { git, commitFiles, raise } = repo;
  const base = git('rev-parse', 'HEAD');
  commitFiles(mainWork, 'main: its own work');
  const tip = raise('0.2.0', 'plugin: version 0.2.0, b arrives');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '--create', HEAD, base);
  commitFiles(work, 'a: a changes (T9)');
  const sha = raise('0.1.1', 'plugin: version 0.1.1, a changes (T9)\n\nThe raise for a.');
  git('push', '-q', 'origin', HEAD);
  const request: CatchUpRequest = { head: HEAD, stem: HEAD, tip, main: 'main', regenerated: listedPaths(TEAMRIG_REGENERATION) };
  const log: string[] = [];
  const deps: CatchUpDeps = { git, log: (line) => log.push(line), readText: (path) => readFileSync(join(repo.dir, path), 'utf8'), writeText: (path, text) => writeFileSync(join(repo.dir, path), text), build: repo.build };
  return { ...repo, base, tip, sha, request, deps, log };
}

test('a teamrig head main moved past drops its version and dist commits, replays its work, raises again on main\'s version and rebuilds the dist (T2988)', (t) => {
  const { git, dir, tip, sha, request, deps, log, base } = movedPast(t);
  const caught = catchUp(deps, request);
  assert.equal(caught.kind, 'rebased');
  const head = caught.kind === 'rebased' ? caught.head : '';
  assert.equal(head, NEXT);
  assert.equal(git('rev-parse', 'HEAD'), caught.kind === 'rebased' ? caught.sha : '');
  assert.equal(git('ls-remote', '--heads', 'origin', `refs/heads/${NEXT}`).split('\t')[0], git('rev-parse', 'HEAD'), 'pushed under the new name');
  assert.equal(git('rev-parse', `refs/heads/${HEAD}`), sha, 'the pushed head itself is never rewritten');
  assert.deepEqual(git('log', '--format=%s', `${tip}..HEAD`).split('\n'), ['build: rebuild the plugin dist', 'plugin: version 0.2.1, a changes (T9)', 'a: a changes (T9)']);
  assert.match(git('log', '-1', '--format=%B', 'HEAD~1'), /^plugin: version 0\.2\.1, a changes \(T9\)\n\nThe raise for a\.\n\nSigned-off-by: t <t@example\.com>$/);
  assert.match(git('log', '-1', '--format=%B', 'HEAD'), /^build: rebuild the plugin dist\n\nCompiled from the commits above by npm run build\.\n\n(.+\n)*Co-Authored-By: /);
  assert.equal(readFileSync(join(dir, KIT), 'utf8'), "export const KIT_VERSION = '0.2.1';\n", 'the rest of the file as main has it');
  assert.equal(readFileSync(join(dir, PLUGIN), 'utf8'), '{\n  "name": "teamrig",\n  "version": "0.2.1"\n}\n');
  assert.equal(git('show', 'HEAD:plugins/teamrig/dist/a.js'), '// built\nexport const a = 2;', 'the dist built from the replayed source');
  assert.equal(git('show', 'HEAD:plugins/teamrig/dist/b.js'), "// built\nexport const b = 1;", 'main\'s own dist stays');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(ownDiff(git, tip, 'HEAD', workPathspec(TEAMRIG_REGENERATION)), ownDiff(git, base, sha, workPathspec(TEAMRIG_REGENERATION)), 'the approved work, unchanged');
  assert.deepEqual(log, [`main moved to ${tip.slice(0, 7)}, which ${HEAD} ${sha.slice(0, 7)} does not contain: replayed its work with the same diff, raised the version 0.1.1 again as 0.2.1, rebuilt the dist (1 file(s)), and pushed it as ${NEXT} ${git('rev-parse', 'HEAD').slice(0, 7)}; merging that`]);
});

test('a teamrig head with no raise and no dist replays its work and makes nothing again (T2988)', (t) => {
  const repo = teamrigRepo(t);
  const { git, commitFiles, raise } = repo;
  const base = git('rev-parse', 'HEAD');
  commitFiles({ 'src/b.ts': 'export const b = 1;\n' }, 'main: its own work');
  const tip = raise('0.2.0', 'plugin: version 0.2.0');
  git('switch', '-q', '--create', HEAD, base);
  const sha = commitFiles({ 'tools/x.ts': 'export const x = 1;\n' }, 'tools: x');
  const log: string[] = [];
  const caught = catchUp({ git, log: (line) => log.push(line), ...NO_REGENERATION }, { head: HEAD, stem: HEAD, tip, main: 'main', regenerated: listedPaths(TEAMRIG_REGENERATION) });
  assert.equal(caught.kind, 'rebased');
  assert.deepEqual(git('log', '--format=%s', `${tip}..HEAD`).split('\n'), ['tools: x']);
  assert.match(log[0] ?? '', new RegExp(`does not contain: replayed its work with the same diff, nothing to make again, and pushed it as ${NEXT} `));
  assert.notEqual(git('rev-parse', 'HEAD'), sha);
});

/** The repo dir as a refused catch-up must leave it: on the head, clean, and no new branch here or on origin. */
function assertRestored(git: (...args: string[]) => string, sha: string): void {
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), HEAD);
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git('branch', '--list', NEXT), '');
  assert.equal(git('ls-remote', '--heads', 'origin', `refs/heads/${NEXT}`), '');
}

const reasonOf = (caught: ReturnType<typeof catchUp>): string => (caught.kind === 'refused' ? caught.reason : '');

test('a work commit that conflicts with main is aborted and refused, the repo dir back on the head (T2988)', (t) => {
  const { git, request, deps, sha } = movedPast(t, { 'src/a.ts': 'export const a = 2;\n' }, { 'src/a.ts': 'export const a = 3;\n' });
  assert.match(reasonOf(catchUp(deps, request)), /, and replaying its commit [0-9a-f]{9} onto that tip conflicts: rebase it by hand, ship it again with its plan \(ship\.ts <dir> <plan\.json> --merge\)/);
  assertRestored(git, sha);
});

test('a commit that mixes work with the version files is refused before any branch (T2988)', (t) => {
  const { git, request, deps, sha } = movedPast(t, { 'src/a.ts': 'export const a = 2;\n', [KIT]: "export const KIT_VERSION = '0.1.1';\n" });
  assert.match(reasonOf(catchUp(deps, request)), /, and its commit [0-9a-f]{9} changes the version files or the dist together with its work, so they cannot be made again apart: ship it again with its plan/);
  assertRestored(git, sha);
});

test('work that writes down the version it raised to is refused when main\'s raise sets another (T2988)', (t) => {
  const { git, request, deps, sha } = movedPast(t, { 'src/a.ts': 'export const a = 2;\n', 'docs/news.md': 'New in 0.1.1: a is 2.\n' });
  assert.match(reasonOf(catchUp(deps, request)), /, and its work names the version 0\.1\.1 it raised to \(docs\/news\.md\), which becomes 0\.2\.1 on that tip: ship it again with its plan/);
  assertRestored(git, sha);
});

test('a failed build is refused with its error, its leftovers cleaned and the repo dir back on the head (T2988)', (t) => {
  const { git, dir, request, deps, sha } = movedPast(t);
  const failing: CatchUpDeps = {
    ...deps,
    build: () => {
      writeFileSync(join(dir, 'plugins/teamrig/dist/half.js'), '// half\n');
      throw new Error('tsc: error TS2322');
    },
  };
  assert.match(reasonOf(catchUp(failing, request)), /, and making its version raise or dist again on that tip failed: tsc: error TS2322$/);
  assertRestored(git, sha);
});

test('a failed push of a caught-up head is refused, the repo dir back on the head (T2988)', (t) => {
  const { git, request, deps, sha } = movedPast(t);
  git('remote', 'set-url', '--push', 'origin', join(tmpdir(), 'no-such-origin-t2988.git'));
  const caught = catchUp(deps, request);
  assert.match(reasonOf(caught), /, and pushing it caught up as t9-change-2 failed: /);
  git('config', '--unset', 'remote.origin.pushurl');
  assertRestored(git, sha);
});

test('another merge landing the same version while the catch-up push runs its gate is caught up again and lands with the next version (T4131)', (t) => {
  const { git, dir, request, deps, sha } = movedPast(t);
  // Another session's merge, from its own clone: its raise takes 0.2.1, the version this catch-up raises to.
  const other = join(dir, '..', 'other');
  execFileSync('git', ['clone', '-q', join(dir, '..', 'origin.git'), other]);
  const inOther = (...args: string[]): string => execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  let gateRuns = 0;
  const racing: CatchUpDeps = {
    ...deps,
    // The pre-push gate runs for minutes; the other merge lands meanwhile and the plugin version gate fails the push.
    git: (...args) => {
      if (args[0] === 'push' && gateRuns++ === 0) {
        writeFileSync(join(other, PLUGIN), '{\n  "name": "teamrig",\n  "version": "0.2.1"\n}\n');
        writeFileSync(join(other, KIT), "export const KIT_VERSION = '0.2.1';\n");
        inOther('commit', '-q', '-a', '-m', 'plugin: version 0.2.1, the other merge');
        inOther('push', '-q', 'origin', 'main');
        throw new Error('pre-push: the plugin version 0.2.1 is already on origin/main');
      }
      return deps.git(...args);
    },
  };
  const first = catchUp(racing, request);
  assert.equal(first.kind, 'moved');
  const landed = inOther('rev-parse', 'HEAD');
  assert.equal(first.kind === 'moved' ? first.tip : '', landed);
  assertRestored(git, sha);

  const second = catchUp(racing, { ...request, tip: first.kind === 'moved' ? first.tip : '' });
  assert.equal(second.kind, 'rebased');
  assert.equal(second.kind === 'rebased' ? second.head : '', NEXT, 'the name the failed push never took');
  assert.equal(git('merge-base', 'HEAD', landed), landed, 'on the other merge');
  assert.equal(readFileSync(join(dir, PLUGIN), 'utf8'), '{\n  "name": "teamrig",\n  "version": "0.2.2"\n}\n');
  assert.equal(readFileSync(join(dir, KIT), 'utf8'), "export const KIT_VERSION = '0.2.2';\n");
  assert.equal(git('ls-remote', '--heads', 'origin', `refs/heads/${NEXT}`).split('\t')[0], git('rev-parse', 'HEAD'));
});
