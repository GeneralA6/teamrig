import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catchUp, ownDiff, type CatchUpRequest } from './catch-up.ts';

const HEAD = 't9-change';
const NEXT = 't9-change-2';
const SHA = 'abc1234def';
const BASE = 'base000aaa';
const TIP = 'moved00bbb';
const REBASED = 'rebased0ccc';
const REQUEST: CatchUpRequest = { head: HEAD, stem: HEAD, tip: TIP, main: 'main' };

const DIFF_AT_BASE = ['diff --git a/src/a.ts b/src/a.ts', 'index 1111111..2222222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10 +10,2 @@ export function a() {', '-old', '+new', '+more'].join('\n');
/** The same change on the moved main: other blob ids, its lines further down. */
const DIFF_ON_TIP = DIFF_AT_BASE.replace('index 1111111..2222222', 'index 3333333..4444444').replace('@@ -10 +10,2 @@', '@@ -14 +14,2 @@');

interface Fixture {
  checkedOut?: string;
  status?: string;
  rebase?: 'clean' | 'conflict';
  diffOnTip?: string;
  push?: Error;
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
  assert.deepEqual(catchUp({ git, log: (line) => log.push(line) }, REQUEST), { kind: 'rebased', head: NEXT, sha: REBASED });
  assert.ok(calls.indexOf(`switch --quiet --create ${NEXT}`) < calls.indexOf(`rebase --quiet ${TIP}`), 'the pushed head itself is never rewritten');
  assert.equal(calls.at(-1), `push --quiet origin HEAD:refs/heads/${NEXT}`);
  assert.ok(!calls.some((call) => call.includes('--force')), 'a new name needs no force');
  assert.deepEqual(log, [`main moved to moved00, which ${HEAD} abc1234 does not contain: rebased it cleanly with the same diff and pushed it as ${NEXT} rebased; merging that`]);
});

test('numbers a later head from the stem the merge began with', () => {
  const { git, calls } = fakeGit();
  catchUp({ git, log: () => undefined }, { ...REQUEST, stem: 't9' });
  assert.ok(calls.includes('branch --list t9-2'));
});

/** The calls that put the repo dir back as it was, after a rebase as NEXT was tried. */
const RESTORED = [`switch --quiet ${HEAD}`, `branch --quiet --delete --force ${NEXT}`];

test('a conflicting rebase is aborted and refused, with the head checked out again and no new branch left', () => {
  const { git, calls } = fakeGit({ rebase: 'conflict' });
  const result = catchUp({ git, log: () => undefined }, REQUEST);
  assert.equal(result.kind, 'refused');
  assert.match(result.kind === 'refused' ? result.reason : '', /^main moved to moved00, which t9-change abc1234 does not contain, and rebasing it onto that tip conflicts: rebase it by hand/);
  assert.deepEqual(calls.slice(-3), ['rebase --abort', ...RESTORED]);
  assert.ok(!calls.some((call) => call.startsWith('push')));
});

test('a clean rebase whose diff changed is refused and never pushed', () => {
  const { git, calls } = fakeGit({ diffOnTip: DIFF_ON_TIP.replace('+more', '+other') });
  const result = catchUp({ git, log: () => undefined }, REQUEST);
  assert.match(result.kind === 'refused' ? result.reason : '', /, and its diff changes when rebased onto that tip: rebase it by hand, check it/);
  assert.deepEqual(calls.slice(-2), RESTORED);
  assert.ok(!calls.some((call) => call.startsWith('push')));
});

test('a failed push is refused with its error, the repo dir back on the head', () => {
  const { git, calls } = fakeGit({ push: new Error('pre-push: the local gate failed') });
  const result = catchUp({ git, log: () => undefined }, REQUEST);
  assert.match(result.kind === 'refused' ? result.reason : '', /, and pushing it rebased as t9-change-2 failed: pre-push: the local gate failed$/);
  assert.deepEqual(calls.slice(-2), RESTORED);
});

test('a head not checked out, or a repo dir with uncommitted changes, is refused before any branch or rebase', () => {
  for (const [fixture, why] of [
    [{ checkedOut: 'other' }, /, and it is not checked out in the repo dir to be rebased there/],
    [{ status: ' M src/a.ts' }, /, and the repo dir has uncommitted changes/],
  ] as const) {
    const { git, calls } = fakeGit(fixture);
    const result = catchUp({ git, log: () => undefined }, REQUEST);
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
