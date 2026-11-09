import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { TempRepo } from '../lib/temp-repo.ts';
import { type BranchCommit, earlierRunCommits, takeBackEarlierRun } from './rerun.ts';
import { DIST, DIST_SUBJECT } from './ship-commits.ts';
import type { Chunk } from './ship-plan.ts';

const PLUGIN = 'plugins/teamrig/.claude-plugin/plugin.json';
const CHUNKS: readonly Chunk[] = [
  { files: ['src/a.ts', 'src/a.test.ts', 'src/new.ts'], subject: 'core: a', body: 'why a' },
  { files: [PLUGIN], subject: 'plugin: version 0.2.0, a', body: 'raises it' },
];

const commit = (sha: string, subject: string, ...files: string[]): BranchCommit => ({ sha, subject, files });
const A = commit('a1', 'core: a', 'src/a.ts', 'src/new.ts');
const RAISE = commit('r1', 'plugin: version 0.2.0, a', PLUGIN);
const BUILT = commit('d1', DIST_SUBJECT, `${DIST}/a.js`, `${DIST}/b.js`);
const HAND = commit('h1', 'core: an earlier fix', 'src/b.ts');

describe('earlierRunCommits', () => {
  test('counts the plan chunks an earlier run committed in order, and its dist commit after them', () => {
    assert.equal(earlierRunCommits([HAND, A, RAISE, BUILT], CHUNKS), 3);
    assert.equal(earlierRunCommits([HAND, A, RAISE], CHUNKS), 2, 'the build failed before the dist commit');
    assert.equal(earlierRunCommits([HAND, A], CHUNKS), 1, 'a chunk commit failed after the first');
    assert.equal(earlierRunCommits([HAND, A, BUILT], CHUNKS), 2, 'a plan that grew a chunk since its run');
  });

  test('matches a raise the sync set again on a newer main, whatever version its subject names', () => {
    assert.equal(earlierRunCommits([A, commit('r2', 'plugin: version 0.3.0, a', PLUGIN), BUILT], CHUNKS), 3);
  });

  test('takes back nothing when the branch does not end in the plan: a hand commit, other files, another order or subject', () => {
    assert.equal(earlierRunCommits([], CHUNKS), 0);
    assert.equal(earlierRunCommits([HAND], CHUNKS), 0);
    assert.equal(earlierRunCommits([A, RAISE, BUILT, HAND], CHUNKS), 0, 'a commit made after the run');
    assert.equal(earlierRunCommits([commit('a2', 'core: a', 'src/a.ts', 'src/b.ts')], CHUNKS), 0, 'a file the chunk does not list');
    assert.equal(earlierRunCommits([RAISE], CHUNKS), 0, "the plan's second chunk without its first");
    assert.equal(earlierRunCommits([commit('a3', 'core: a, again', 'src/a.ts')], CHUNKS), 0, 'another subject');
    assert.equal(earlierRunCommits([commit('e1', 'core: a')], CHUNKS), 0, 'a commit that changed no file');
    assert.equal(earlierRunCommits([BUILT], CHUNKS), 0, 'a dist commit alone is no run of this plan');
    assert.equal(earlierRunCommits([A, commit('d2', DIST_SUBJECT, `${DIST}/a.js`, 'src/a.ts')], CHUNKS), 0, 'a dist commit with a source file');
  });
});

describe('takeBackEarlierRun', () => {
  let repo: TempRepo;
  let logs: string[];
  let fork: string;
  const deps = () => ({ git: (...args: string[]) => repo.git(...args).trim(), log: (line: string) => logs.push(line) });
  const commitFiles = (subject: string, files: Readonly<Record<string, string>>): void => {
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git('add', '--', ...Object.keys(files));
    repo.git('commit', '-q', '-m', subject);
  };
  const status = (): string[] => repo.git('status', '--porcelain', '--untracked-files=all').split('\n').filter((line) => line !== '').sort();
  const head = (): string => repo.git('rev-parse', 'HEAD').trim();

  beforeEach(() => {
    logs = [];
    repo = new TempRepo('rerun').init();
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    commitFiles('base', { 'src/a.ts': 'a\n', [PLUGIN]: '{ "version": "0.1.0" }\n', [`${DIST}/a.js`]: 'a\n' });
    const origin = join(repo.outside, 'origin.git');
    repo.git('init', '-q', '--bare', origin);
    repo.git('remote', 'add', 'origin', origin);
    repo.git('push', '-q', 'origin', 'main');
    repo.git('fetch', '-q', 'origin');
    repo.git('checkout', '-q', '-b', 't1-change');
    commitFiles('core: an earlier fix', { 'src/b.ts': 'b\n' });
    fork = head();
  });

  afterEach(() => repo.remove());

  const earlierRun = (): void => {
    commitFiles('core: a', { 'src/a.ts': 'a2\n', 'src/new.ts': 'new\n' });
    commitFiles('plugin: version 0.2.0, a', { [PLUGIN]: '{ "version": "0.2.0" }\n' });
    commitFiles(DIST_SUBJECT, { [`${DIST}/a.js`]: 'a2\n', [`${DIST}/new.js`]: 'new\n' });
  };

  test("takes back the earlier run's chunks and dist with every change kept unstaged, a fix made since too", () => {
    earlierRun();
    repo.write('src/a.ts', 'a3, the fix after the failed gate\n');
    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 3);
    assert.equal(head(), fork, 'the hand commit before the run stays');
    assert.deepEqual(status(), [` M ${PLUGIN}`, ` M ${DIST}/a.js`, ' M src/a.ts', `?? ${DIST}/new.js`, '?? src/new.ts']);
    assert.equal(repo.git('show', ':src/a.ts'), 'a\n', 'nothing stays staged');
    assert.match(logs.join('\n'), /^took back 3 commit\(s\) an earlier run of this plan made \([0-9a-f]{7}, [0-9a-f]{7}, [0-9a-f]{7}\): the plan commits them again$/);

    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 0, 'a second run finds nothing to take back');
    assert.equal(logs.length, 1);
  });

  test('takes back what a run stopped partway committed', () => {
    commitFiles('core: a', { 'src/a.ts': 'a2\n' });
    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 1);
    assert.equal(head(), fork);
    assert.deepEqual(status(), [' M src/a.ts']);
  });

  test('leaves a branch that does not end in the plan as it is', () => {
    earlierRun();
    commitFiles('core: a later hand commit', { 'src/c.ts': 'c\n' });
    const before = head();
    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 0);
    assert.equal(head(), before);
    assert.deepEqual(status(), []);
    assert.deepEqual(logs, []);
  });

  test('refuses to rewrite commits already pushed to origin, and leaves the branch as it is', () => {
    earlierRun();
    repo.git('push', '-q', 'origin', 't1-change');
    const before = head();
    assert.throws(
      () => takeBackEarlierRun(deps(), CHUNKS, 'origin/main'),
      /^Error: REFUSED 3 commit\(s\) an earlier run of this plan made are on origin\/t1-change, and a pushed branch is never rewritten: ship the change under a new branch name \(git branch -m t1-change t1-change-b\), then ship again$/,
    );
    assert.equal(head(), before);
    assert.deepEqual(status(), []);

    repo.git('branch', '-m', 't1-change', 't1-change-b');
    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 3, 'the new name is not on origin');
  });

  test('a branch pushed before the run, whose origin tip lacks the run, is taken back', () => {
    repo.git('push', '-q', 'origin', 't1-change');
    earlierRun();
    assert.equal(takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), 3);
    assert.equal(head(), fork);
  });

  test("an origin tip this clone lacks counts as pushed: it may hold the run's commits", () => {
    earlierRun();
    const other = new TempRepo('rerun-other').init();
    try {
      other.git('symbolic-ref', 'HEAD', 'refs/heads/t1-change');
      other.write('x.txt', 'x\n');
      other.git('add', 'x.txt');
      other.git('commit', '-q', '-m', 'elsewhere');
      other.git('push', '-q', join(repo.outside, 'origin.git'), 't1-change');
    } finally {
      other.remove();
    }
    assert.throws(() => takeBackEarlierRun(deps(), CHUNKS, 'origin/main'), /^Error: REFUSED 3 commit\(s\)/);
  });
});
