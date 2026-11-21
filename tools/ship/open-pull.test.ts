import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { MergeClearance } from './approval.ts';
import type { Gh } from './github.ts';
import type { Credential } from './keychain.ts';
import { type OpenPullArgs, type OpenPullDeps, openPullCommand, parseOpenPullArgs, realOpenPullDeps, runOpenPull } from './open-pull.ts';
import { parseProfiles } from './repos.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const REPO = 'Owner/repo';
const BRANCH = 'feat/t1-a';
const SHA = 'abc1234def5678';
const OTHER = 'fff9999eee0000';
const GH_SECRET = ['github', '_pat_', 'x'].join('');
const NOTE_FILE = 'C:/notes/pr.md';
const NOTE = '## What\n\nA thing.\n\n## Reach\n\nAll users.';
const OPEN_PULLS = `repos/${REPO}/pulls?state=open&base=main&head=Owner:${BRANCH}&per_page=10`;
const ARGS: OpenPullArgs = { dir: 'C:/repo', head: BRANCH, approved: 'abc1234', noteFile: NOTE_FILE };

const pullJson = (sha: string): string => JSON.stringify({ number: 7, html_url: `https://github.com/${REPO}/pull/7`, head: { ref: BRANCH, sha }, base: { ref: 'main' } });

interface Fixture {
  /** Origin's sha of the branch. */
  pushed?: string;
  subjects?: string;
  /** The open pull request's head sha; none when absent. */
  openSha?: string;
  /** The head GitHub opens the new pull request at. */
  openedSha?: string;
  clearance?: MergeClearance;
  credential?: Credential;
  note?: string | null;
  /** An earlier push's open pull request #5, on `${BRANCH}-2` at OLDER, carrying these commit subjects. */
  older?: readonly string[];
}

const OLDER = 'ddd5555ccc1111';
const LIST_PULLS = `repos/${REPO}/pulls?state=open&base=main&per_page=100`;
const workLog = (subjects: readonly string[]): string => subjects.map(subject => `\0base000\t${subject}\n\nsrc/${subject.length}.ts\n`).join('');
const workOf = (sha: string): string => `log --right-only --cherry-pick --format=%x00%P%x09%s --name-only refs/remotes/origin/main...${sha}`;

/** A repo dir whose git answers from a table, GitHub with at most one open pull request, and a recorded caller. */
function fixture(options: Fixture = {}): {
  deps: OpenPullDeps;
  out: string[];
  err: string[];
  writes: string[][];
  gh: ReturnType<typeof mock.fn<Gh>>;
  ghFor: ReturnType<typeof mock.fn<OpenPullDeps['ghFor']>>;
  clearMerge: ReturnType<typeof mock.fn<OpenPullDeps['clearMerge']>>;
} {
  const pushed = options.pushed ?? SHA;
  const answers: Record<string, string> = {
    'remote get-url origin': `git@github.com:${REPO}.git`,
    [`fetch --quiet origin ${BRANCH} main`]: '',
    [`rev-parse refs/remotes/origin/${BRANCH}`]: pushed,
    [`log --reverse --format=%s refs/remotes/origin/main..${pushed}`]: options.subjects ?? 'cli: a\ndocs: b',
    'fetch --quiet origin refs/pull/5/head': '',
    [workOf(pushed)]: workLog((options.subjects ?? 'cli: a\ndocs: b').split('\n')),
    [workOf(OLDER)]: workLog(options.older ?? []),
  };
  const writes: string[][] = [];
  const older = { number: 5, html_url: `https://github.com/${REPO}/pull/5`, head: { ref: `${BRANCH}-2`, sha: OLDER, repo: { full_name: REPO } }, base: { ref: 'main' } };
  const gh = mock.fn<Gh>(args => {
    const path = args[1] ?? '';
    if (args.includes('-X')) writes.push([...args]);
    if (path === OPEN_PULLS) return options.openSha === undefined ? '[]' : `[${pullJson(options.openSha)}]`;
    if (path === `repos/${REPO}/pulls`) return pullJson(options.openedSha ?? pushed);
    if (path === LIST_PULLS) return `[${pullJson(pushed)}${options.older === undefined ? '' : `,${JSON.stringify(older)}`}]`;
    if (path === `repos/${REPO}/issues/5/comments` || path === `repos/${REPO}/pulls/5`) return '{}';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  const ghFor = mock.fn<OpenPullDeps['ghFor']>(() => gh);
  const clearMerge = mock.fn<OpenPullDeps['clearMerge']>(() => Promise.resolve(options.clearance ?? { kind: 'approved', by: 'teamrig' }));
  const out: string[] = [];
  const err: string[] = [];
  const deps: OpenPullDeps = {
    git: (...args) => {
      const answer = answers[args.join(' ')];
      if (answer === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
      return answer;
    },
    profiles: parseProfiles(`{"${REPO}":{"main":"main","gate":"ci","checks":["gates"],"pullSections":["What","Reach"]}}`),
    credential: () => options.credential ?? { kind: 'found', secret: GH_SECRET },
    ghFor,
    clearMerge,
    readText: path => (path === NOTE_FILE ? (options.note === undefined ? NOTE : options.note) : null),
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return { deps, out, err, writes, gh, ghFor, clearMerge };
}

const fieldOf = (write: readonly string[], name: string): string | undefined => write.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);

test('opens the pull request of the approved pushed head with the ship token and prints its URL (T4364)', async () => {
  const { deps, out, err, writes, ghFor, clearMerge } = fixture();
  assert.equal(await runOpenPull(ARGS, deps), 0, err.join('\n'));
  assert.deepEqual(clearMerge.mock.calls.map(call => call.arguments), [[BRANCH, SHA, 'abc1234']]);
  assert.deepEqual(ghFor.mock.calls.map(call => call.arguments), [[GH_SECRET]]);
  assert.equal(writes.length, 1);
  const [write] = writes;
  assert.ok(write !== undefined);
  assert.equal(fieldOf(write, 'title'), `Merge ${BRANCH} into main: 2 commit(s)`);
  assert.equal(fieldOf(write, 'head'), BRANCH);
  assert.equal(fieldOf(write, 'base'), 'main');
  assert.match(fieldOf(write, 'body') ?? '', /^## What\n\nA thing\.\n\n## Reach\n\nAll users\.\n\n## Commits\n- cli: a\n- docs: b\n/);
  assert.deepEqual(out, [`opened pull request #7 https://github.com/${REPO}/pull/7`]);
});

test('prints the open pull request of the approved head and opens no second one', async () => {
  const { deps, out, writes } = fixture({ openSha: SHA });
  assert.equal(await runOpenPull(ARGS, deps), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(out, [`found pull request #7 https://github.com/${REPO}/pull/7`]);
});

test('closes the earlier push\'s pull request that the one it opened or found replaces (T4780)', async () => {
  for (const open of [{}, { openSha: SHA }]) {
    const { deps, out, writes } = fixture({ ...open, older: ['docs: b'] });
    assert.equal(await runOpenPull(ARGS, deps), 0);
    assert.deepEqual(writes.slice(-2).map(write => write[1]), [`repos/${REPO}/issues/5/comments`, `repos/${REPO}/pulls/5`]);
    assert.deepEqual(out, [`${'openSha' in open ? 'found' : 'opened'} pull request #7 https://github.com/${REPO}/pull/7`, `closed pull request #5 https://github.com/${REPO}/pull/5: superseded by #7`]);
  }
  const kept = fixture({ older: ['docs: b', 'feat: c'] });
  assert.equal(await runOpenPull(ARGS, kept.deps), 0);
  assert.equal(kept.writes.length, 1);
  assert.deepEqual(kept.out.slice(1), [`warning: pull request #5 https://github.com/${REPO}/pull/5 stays open: #7 lacks its "feat: c"`]);
});

test('refuses an open pull request at another head', async () => {
  const { deps, err, writes } = fixture({ openSha: OTHER });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(err, [`REFUSED pull request #7 https://github.com/${REPO}/pull/7 is at fff9999ee, not abc1234de`]);
});

test("refuses when origin's head is not the approved sha, before any approval read or GitHub call", async () => {
  const { deps, err, ghFor, clearMerge } = fixture({ pushed: OTHER });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.deepEqual(err, [`REFUSED origin's ${BRANCH} is at fff9999ee, not the approved abc1234: push the approved head, or ask for approval of fff9999ee`]);
  assert.equal(clearMerge.mock.callCount(), 0);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('refuses a head its approval does not clear, before the token is read', async () => {
  const { deps, err, ghFor } = fixture({ clearance: { kind: 'refused', reason: 'T1 waits on approval:teamrig' } });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.deepEqual(err, ['REFUSED T1 waits on approval:teamrig']);
  assert.equal(ghFor.mock.callCount(), 0);
});

test("opens no pull request whose note lacks the template's sections", async () => {
  const { deps, err, writes } = fixture({ note: '## What\n\nA thing.' });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(err, ["REFUSED the pull request would lack ## Reach, which this repo's template asks for: write it in a --note-file and ship again"]);
  const bare = fixture();
  assert.equal(await runOpenPull({ ...ARGS, noteFile: null }, bare.deps), 1);
  assert.deepEqual(bare.err, ["REFUSED the pull request would lack ## What, ## Reach, which this repo's template asks for: write it in a --note-file and ship again"]);
});

test('says why the ship token is unusable and calls no GitHub', async () => {
  const { deps, err, ghFor } = fixture({ credential: { kind: 'missing' } });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.match(err[0] ?? '', /: not stored\. Store it/);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('refuses a pull request GitHub opened at a head pushed since the read', async () => {
  const { deps, err, out } = fixture({ openedSha: OTHER });
  assert.equal(await runOpenPull(ARGS, deps), 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, [`REFUSED pull request #7 https://github.com/${REPO}/pull/7 opened at fff9999ee, not the approved abc1234de: ${BRANCH} moved, so close it`]);
});

test('says in one line why a run cannot start: main as head, nothing to ship, a missing note file', async () => {
  const main = fixture();
  assert.equal(await openPullCommand(['C:/repo', '--head', 'main', '--approved', 'abc1234'], () => main.deps), 1);
  assert.deepEqual(main.err, ['main is the branch merged into: name a change branch']);
  const empty = fixture({ subjects: '' });
  assert.equal(await openPullCommand(['C:/repo', '--head', BRANCH, '--approved', 'abc1234'], () => empty.deps), 1);
  assert.deepEqual(empty.err, [`${BRANCH} has nothing that main lacks`]);
  const unnoted = fixture({ note: null });
  assert.equal(await openPullCommand(['C:/repo', '--head', BRANCH, '--approved', 'abc1234', '--note-file', NOTE_FILE], () => unnoted.deps), 1);
  assert.deepEqual(unnoted.err, [`--note-file ${NOTE_FILE}: no such file`]);
  const opened = fixture();
  assert.equal(await openPullCommand(['C:/repo', '--head', BRANCH, '--approved', 'abc1234', '--note-file', NOTE_FILE], () => opened.deps), 0);
});

test('parses the repo dir, a head, an approved sha and a note file, each required but the note', () => {
  assert.deepEqual(parseOpenPullArgs(['C:/repo', '--head', BRANCH, '--approved', 'abc1234', '--note-file', NOTE_FILE]), ARGS);
  assert.deepEqual(parseOpenPullArgs(['C:/repo', '--approved', 'abc1234', '--head', BRANCH]), { ...ARGS, noteFile: null });
  const usage = 'usage: ship.ts pr <repo dir> --head <branch> --approved <sha> [--note-file <path>]';
  assert.throws(() => parseOpenPullArgs([]), { message: usage });
  assert.throws(() => parseOpenPullArgs(['--head', BRANCH]), { message: usage });
  assert.throws(() => parseOpenPullArgs(['C:/repo', '--head', BRANCH]), { message: `${usage} (--head and --approved are required)` });
  assert.throws(() => parseOpenPullArgs(['C:/repo', '--approved', 'abc1234']), { message: `${usage} (--head and --approved are required)` });
  assert.throws(() => parseOpenPullArgs(['C:/repo', '--approved', 'XYZ']), { message: `${usage} (got --approved XYZ)` });
  assert.throws(() => parseOpenPullArgs(['C:/repo', '--head']), { message: '--head needs a value' });
});

test('the real deps run git in the repo dir and read a note file, or null when it is missing', () => {
  const repo = new TempRepo('open-pull');
  try {
    repo.init().write('a.txt', 'a\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'a');
    const deps = realOpenPullDeps(repo.dir);
    assert.equal(deps.git('rev-parse', 'HEAD'), repo.git('rev-parse', 'HEAD').trim());
    assert.equal(deps.readText(join(repo.dir, 'a.txt')), 'a\n');
    assert.equal(deps.readText(join(repo.dir, 'no-such.md')), null);
    const log = mock.method(console, 'log', () => undefined);
    const error = mock.method(console, 'error', () => undefined);
    try {
      deps.out('o');
      deps.err('e');
      assert.deepEqual(log.mock.calls.map(call => call.arguments), [['o']]);
      assert.deepEqual(error.mock.calls.map(call => call.arguments), [['e']]);
    } finally {
      log.mock.restore();
      error.mock.restore();
    }
  } finally {
    repo.remove();
  }
});
