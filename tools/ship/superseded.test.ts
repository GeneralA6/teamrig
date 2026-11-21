import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import type { OpenPull, PullRequest } from './pulls.ts';
import { type PullCommits, pullCommitsOf, replaceable, stemOf, supersedeFrom } from './superseded.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const REPO = 'Owner/repo';
const LIST = `repos/${REPO}/pulls?state=open&base=main&per_page=100`;
const STEM = 'fix/t1-catch-up';

const pullOf = (number: number, headRef: string, headSha = `sha${number}`): PullRequest => ({ number, url: `https://github.com/${REPO}/pull/${number}`, headRef, headSha, baseRef: 'main' });
const openOf = (number: number, headRef: string, headRepo: string | null = REPO): OpenPull => ({ ...pullOf(number, headRef), headRepo });
const listed = (pulls: readonly OpenPull[]): string =>
  JSON.stringify(pulls.map(pull => ({ number: pull.number, html_url: pull.url, head: { ref: pull.headRef, sha: pull.headSha, repo: pull.headRepo === null ? null : { full_name: pull.headRepo } }, base: { ref: 'main' } })));

/** GitHub listing `open` and recording every write; a write to a number in `failing` throws. */
function fakeGitHub(open: readonly OpenPull[] | Error, failing: readonly number[] = []): { gh: Gh; writes: string[][] } {
  const writes: string[][] = [];
  const gh: Gh = args => {
    const path = args[1] ?? '';
    if (path === LIST) {
      if (open instanceof Error) throw open;
      return listed(open);
    }
    if (!args.includes('-X')) throw new Error(`unexpected gh ${args.join(' ')}`);
    if (failing.some(number => path.endsWith(`/${number}`) || path.endsWith(`/${number}/comments`))) throw new Error(`gh api ${path}: HTTP 403: Resource not accessible`);
    writes.push([...args]);
    return '{}';
  };
  return { gh, writes };
}

/** Commits by head sha; a sha not listed cannot be read. */
function fakeCommits(bySha: Readonly<Record<string, readonly string[]>>): PullCommits & { fetched: number[] } {
  const fetched: number[] = [];
  return {
    fetched,
    fetch: number => {
      fetched.push(number);
    },
    subjects: sha => bySha[sha] ?? assert.fail(`no commits for ${sha}`),
  };
}

const closeWrites = (number: number, by: PullRequest): string[][] => [
  ['api', `repos/${REPO}/issues/${number}/comments`, '-X', 'POST', '-f', `body=Superseded by #${by.number} ${by.url}: \`${by.headRef}\` carries this change again on a newer \`main\`.`],
  ['api', `repos/${REPO}/pulls/${number}`, '-X', 'PATCH', '-f', 'state=closed'],
];

test('a branch\'s stem drops every -N suffix a reship adds', () => {
  assert.equal(stemOf(`${STEM}-5`), STEM);
  assert.equal(stemOf(`${STEM}-5-2`), STEM);
  assert.equal(stemOf(STEM), STEM);
  assert.equal(stemOf('fix/t12-x2'), 'fix/t12-x2');
});

test('replaces only the older open pull requests of the same stem in the repo itself', () => {
  const pull = pullOf(40, `${STEM}-3`);
  const open = [
    openOf(40, `${STEM}-3`),
    openOf(31, STEM),
    openOf(35, `${STEM}-2`),
    openOf(44, `${STEM}-4`),
    openOf(33, `${STEM}-2`, 'Fork/repo'),
    openOf(32, `${STEM}-9`, null),
    openOf(30, 'fix/t1-catch-up-more'),
    openOf(29, 'fix/t2-other-3'),
  ];
  assert.deepEqual(replaceable(pull, open, REPO).map(other => other.number), [31, 35]);
  assert.deepEqual(replaceable(pull, [openOf(35, `${STEM}-2`, 'owner/REPO')], REPO).map(other => other.number), [35]);
});

test('closes each older pull request whose work the new head carries, with a comment linking the new one', () => {
  const pull = pullOf(40, `${STEM}-3`);
  const { gh, writes } = fakeGitHub([openOf(40, `${STEM}-3`), openOf(35, `${STEM}-2`), openOf(31, STEM)]);
  const commits = fakeCommits({ sha40: ['fix(ship): a', 'test(ship): b'], sha35: ['fix(ship): a', 'test(ship): b'], sha31: ['fix(ship): a'] });
  const log: string[] = [];
  supersedeFrom(gh, REPO, 'main', commits, line => log.push(line))(pull);
  assert.deepEqual(commits.fetched, [35, 31]);
  assert.deepEqual(writes, [...closeWrites(35, pull), ...closeWrites(31, pull)]);
  assert.deepEqual(log, [
    `closed pull request #35 https://github.com/${REPO}/pull/35: superseded by #40`,
    `closed pull request #31 https://github.com/${REPO}/pull/31: superseded by #40`,
  ]);
});

test('leaves open an older pull request with work the new head lacks, naming it', () => {
  const pull = pullOf(40, `${STEM}-3`);
  const { gh, writes } = fakeGitHub([openOf(35, `${STEM}-2`)]);
  const log: string[] = [];
  supersedeFrom(gh, REPO, 'main', fakeCommits({ sha40: ['fix(ship): a'], sha35: ['fix(ship): a', 'docs(ship): c'] }), line => log.push(line))(pull);
  assert.deepEqual(writes, []);
  assert.deepEqual(log, [`warning: pull request #35 https://github.com/${REPO}/pull/35 stays open: #40 lacks its "docs(ship): c"`]);
});

test('reads no commits when no older pull request shares the stem', () => {
  const subjects = mock.fn<PullCommits['subjects']>(() => []);
  const log: string[] = [];
  supersedeFrom(fakeGitHub([openOf(40, `${STEM}-3`), openOf(35, 'fix/t2-other')]).gh, REPO, 'main', { fetch: () => undefined, subjects }, line => log.push(line))(pullOf(40, `${STEM}-3`));
  assert.equal(subjects.mock.callCount(), 0);
  assert.deepEqual(log, []);
});

test('a failure is a warning line and never throws: the listing, the new head\'s commits, one close', () => {
  const pull = pullOf(40, `${STEM}-3`);
  const log: string[] = [];
  supersedeFrom(fakeGitHub(new Error('gh api: HTTP 502')).gh, REPO, 'main', fakeCommits({}), line => log.push(line))(pull);
  supersedeFrom(fakeGitHub([openOf(35, `${STEM}-2`)]).gh, REPO, 'main', fakeCommits({}), line => log.push(line))(pull);
  const partly = fakeGitHub([openOf(36, `${STEM}-2`), openOf(35, STEM)], [36]);
  supersedeFrom(partly.gh, REPO, 'main', fakeCommits({ sha40: ['a'], sha36: ['a'], sha35: ['a'] }), line => log.push(line))(pull);
  assert.deepEqual(log, [
    `warning: the older pull requests of ${STEM}-3 were not looked for: gh api: HTTP 502`,
    `warning: the older pull requests of ${STEM}-3 stay open, as its commits could not be read: no commits for sha40`,
    `warning: pull request #36 https://github.com/${REPO}/pull/36 was not closed: gh api repos/${REPO}/issues/36/comments: HTTP 403: Resource not accessible`,
    `closed pull request #35 https://github.com/${REPO}/pull/35: superseded by #40`,
  ]);
  assert.deepEqual(partly.writes, closeWrites(35, pull));
});

test('a pull request\'s work subjects through git leave out what main repeats and what only regenerates', () => {
  const repo = new TempRepo('superseded').init();
  try {
    const commit = (subject: string, files: Readonly<Record<string, string>>): string => {
      for (const [path, content] of Object.entries(files)) repo.write(path, content);
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', subject);
      return repo.git('rev-parse', 'HEAD').trim();
    };
    const base = commit('base', { 'a.txt': 'a\n' });
    commit('fix: on both', { 'b.txt': 'b\n' });
    commit('build: rebuild the dist', { 'dist/x.js': 'x\n' });
    const tip = commit('feat: only here', { 'c.txt': 'c\n' });
    repo.git('checkout', '-q', '-b', 'trunk', base);
    commit('fix: on both', { 'b.txt': 'b\n' });
    repo.git('update-ref', 'refs/remotes/origin/main', repo.git('rev-parse', 'HEAD').trim());
    const git = (...args: string[]): string => repo.git(...args).trim();
    assert.deepEqual(pullCommitsOf(git, 'main', ['dist/']).subjects(tip), ['feat: only here']);
    assert.deepEqual(pullCommitsOf(git, 'main', []).subjects(tip), ['feat: only here', 'build: rebuild the dist']);
  } finally {
    repo.remove();
  }
});

test('fetches a pull request\'s head by its pull ref', () => {
  const git = mock.fn((..._args: string[]): string => '');
  pullCommitsOf(git, 'main', []).fetch(35);
  assert.deepEqual(git.mock.calls[0]?.arguments, ['fetch', '--quiet', 'origin', 'refs/pull/35/head']);
});
