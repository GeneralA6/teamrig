import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import type { Credential } from './keychain.ts';
import type { GateDeps } from './local-gate.ts';
import { type OpenArgs, type OpenDeps, OPEN_USAGE, openCommand, parseOpenArgs, runOpen } from './open.ts';
import { parseProfiles } from './repos.ts';

const REPO = 'Owner/repo';
const GH_SECRET = ['github', '_pat_', 'x'].join('');
const SHA = 'abc1234def';
const BRANCH = 't9-change';
const ATTRIBUTION = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

interface Fixture {
  checkedOut?: string;
  pushedSha?: string;
  subjects?: string;
  /** The head sha of an open pull request from the branch; none when left out. */
  openPullSha?: string;
  /** The head sha GitHub gives the pull request it opens; SHA when left out. */
  openedSha?: string;
  credential?: Credential;
}

interface Run {
  deps: OpenDeps;
  gitCalls: string[];
  ghCalls: string[][];
  ghFor: ReturnType<typeof mock.fn<(token: string) => Gh>>;
  out: string[];
  err: string[];
}

function openFixture(fixture: Fixture = {}): Run {
  const gitCalls: string[] = [];
  const ghCalls: string[][] = [];
  const answers: Record<string, string> = {
    'remote get-url origin': `git@github.com:${REPO}.git`,
    'rev-parse --abbrev-ref HEAD': fixture.checkedOut ?? BRANCH,
    [`fetch --quiet origin ${BRANCH} main`]: '',
    [`rev-parse refs/heads/${BRANCH}`]: SHA,
    [`rev-parse refs/remotes/origin/${BRANCH}`]: fixture.pushedSha ?? SHA,
    [`log --reverse --format=%s refs/remotes/origin/main..${SHA}`]: fixture.subjects ?? 'cli: a\ndocs: b',
  };
  const pull = (number: number, sha: string): string => JSON.stringify({ number, html_url: `https://github.com/${REPO}/pull/${number}`, head: { ref: BRANCH, sha }, base: { ref: 'main' } });
  const gh = mock.fn<Gh>(args => {
    ghCalls.push([...args]);
    const path = args[1] ?? '';
    if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return fixture.openPullSha === undefined ? '[]' : `[${pull(3, fixture.openPullSha)}]`;
    if (path === `repos/${REPO}/pulls`) return pull(4, fixture.openedSha ?? SHA);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  const gate: GateDeps = {
    git: () => {
      throw new Error('open runs no local check');
    },
    exists: () => false,
    readText: path => (path === 'C:/notes/review.md' ? '## Review\nthe classifier change\n' : null),
    writeText: () => {
      throw new Error('open writes no file');
    },
    run: () => {
      throw new Error('open runs no local check');
    },
    now: () => new Date('2026-11-14T03:00:00Z'),
    log: () => undefined,
  };
  const ghFor = mock.fn((_token: string): Gh => gh);
  const out: string[] = [];
  const err: string[] = [];
  const deps: OpenDeps = {
    git: (...args) => {
      const key = args.join(' ');
      gitCalls.push(key);
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unexpected git ${key}`);
      return answer;
    },
    profiles: parseProfiles(`{"${REPO}":{"main":"main","gate":"local","checks":[],"local":{"runner":"tools/ci/local.ts"}}}`),
    gate,
    credential: () => fixture.credential ?? { kind: 'found', secret: GH_SECRET },
    ghFor,
    out: line => out.push(line),
    err: line => err.push(line),
  };
  return { deps, gitCalls, ghCalls, ghFor, out, err };
}

const ARGS: OpenArgs = { dir: 'C:/repo', head: BRANCH, noteFile: null };

/** The writes a run sent to GitHub. */
const writes = (run: Run): string[][] => run.ghCalls.filter(args => args.includes('-X'));

test('opens the pull request of the pushed head into main with the ship key, and merges nothing', () => {
  const run = openFixture();
  assert.equal(runOpen(ARGS, run.deps), 0);
  assert.deepEqual(run.err, []);
  assert.deepEqual(run.out, [`OPENED #4 https://github.com/${REPO}/pull/4`, `it stays open for review: merge it with ship.ts merge C:/repo --head ${BRANCH}`]);
  assert.equal(run.ghFor.mock.calls[0]?.arguments[0], GH_SECRET);
  assert.deepEqual(writes(run), [
    ['api', `repos/${REPO}/pulls`, '-X', 'POST', '-f', `title=Merge ${BRANCH} into main: 2 commit(s)`, '-f', `head=${BRANCH}`, '-f', 'base=main', '-f', `body=- cli: a\n- docs: b\n\n${ATTRIBUTION}`],
  ]);
});

test('reports a pull request already open from the head and opens no second one', () => {
  const run = openFixture({ openPullSha: SHA });
  assert.equal(runOpen({ ...ARGS, head: null }, run.deps), 0);
  assert.deepEqual(run.out, [`FOUND #3 https://github.com/${REPO}/pull/3`, 'it stays open for review: merge it with ship.ts merge C:/repo']);
  assert.deepEqual(writes(run), []);
  assert.ok(run.gitCalls.includes('rev-parse --abbrev-ref HEAD'), 'without --head it takes the checked-out branch');
});

test('refuses a pull request whose head is not the pushed sha yet', () => {
  for (const fixture of [{ openPullSha: 'fff0000aaa' }, { openedSha: 'fff0000aaa' }]) {
    const run = openFixture(fixture);
    assert.equal(runOpen(ARGS, run.deps), 1);
    assert.match(run.err[0] ?? '', /^REFUSED the pull request #\d head fff0000 is not t9-change abc1234: GitHub has not seen the push yet, so run open again$/);
    assert.deepEqual(run.out, []);
  }
});

test("makes merge's checks before the key is read or any GitHub call", () => {
  for (const [args, fixture, message] of [
    [ARGS, { pushedSha: 'other' }, new RegExp(`${BRANCH} abc1234 is not pushed: push it first`)],
    [ARGS, { subjects: '' }, new RegExp(`${BRANCH} has nothing that main lacks`)],
    [{ ...ARGS, head: 'main' }, {}, /main is the branch merged into: ship a change branch/],
    [{ ...ARGS, head: null }, { checkedOut: 'HEAD' }, /detached HEAD: pass --head <branch>/],
    [{ ...ARGS, noteFile: 'C:/notes/none.md' }, {}, /--note-file C:\/notes\/none\.md: no such file/],
  ] as const) {
    let keyReads = 0;
    const run = openFixture(fixture);
    const counted: OpenDeps = {
      ...run.deps,
      credential: () => {
        keyReads += 1;
        return run.deps.credential();
      },
    };
    assert.throws(() => runOpen(args, counted), message);
    assert.equal(keyReads, 0);
    assert.equal(run.ghFor.mock.callCount(), 0);
  }
});

test('without a stored ship key it says how to store one and makes no GitHub call', () => {
  const run = openFixture({ credential: { kind: 'missing' } });
  assert.equal(runOpen(ARGS, run.deps), 1);
  assert.match(run.err[0] ?? '', /teamrig-ship-gh: not stored/);
  assert.equal(run.ghFor.mock.callCount(), 0);
});

test('--note-file opens the body above the commits', () => {
  const run = openFixture();
  assert.equal(runOpen({ ...ARGS, noteFile: 'C:/notes/review.md' }, run.deps), 0);
  const body = writes(run)[0]?.find(arg => arg.startsWith('body='));
  assert.equal(body, `body=## Review\nthe classifier change\n\n## Commits\n- cli: a\n- docs: b\n\n${ATTRIBUTION}`);
});

test('reads --head and --note-file, and refuses anything else with the usage', () => {
  assert.deepEqual(parseOpenArgs(['C:/repo']), { dir: 'C:/repo', head: null, noteFile: null });
  assert.deepEqual(parseOpenArgs(['C:/repo', '--head', 'feature/x-1', '--note-file', 'C:/n.md']), { dir: 'C:/repo', head: 'feature/x-1', noteFile: 'C:/n.md' });
  assert.throws(() => parseOpenArgs([]), new Error(OPEN_USAGE));
  assert.throws(() => parseOpenArgs(['--head', 'x']), new Error(OPEN_USAGE));
  assert.throws(() => parseOpenArgs(['C:/repo', '--head']), /--head needs a value/);
  assert.throws(() => parseOpenArgs(['C:/repo', '--head', 'a b']), /\(got --head a b\)$/);
  assert.throws(() => parseOpenArgs(['C:/repo', '--note-file', '--head']), /\(got --note-file --head\)$/);
  assert.throws(() => parseOpenArgs(['C:/repo', '--timeout-min', '5']), /\(got --timeout-min 5\)$/);
});

test('the command turns a usage or git error into one line and exit 1', t => {
  const consoleError = t.mock.method(console, 'error', () => undefined);
  assert.equal(openCommand([]), 1);
  assert.equal(String(consoleError.mock.calls[0]?.arguments[0]), OPEN_USAGE);
  consoleError.mock.restore();

  const broken = openFixture({ pushedSha: 'other' });
  assert.equal(openCommand(['C:/repo'], () => broken.deps), 1);
  assert.deepEqual(broken.err, [`${BRANCH} abc1234 is not pushed: push it first`]);
  const opened = openFixture();
  assert.equal(openCommand(['C:/repo', '--head', BRANCH], () => opened.deps), 0);
  assert.equal(opened.out[0], `OPENED #4 https://github.com/${REPO}/pull/4`);
});
