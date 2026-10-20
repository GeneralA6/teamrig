import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import { describeCredential, parseArgs, tokenCheck } from './token-check.ts';

const SECRET = ['github', '_pat_', '11SECRETSECRETSECRET'].join('');
const REPO = 'Owner/repo';

/** A token that reads everything but check runs, as a fine-grained one does. */
function fineGrainedGh(refuse: readonly string[] = []): ReturnType<typeof mock.fn<Gh>> {
  return mock.fn<Gh>(args => {
    const path = args[0] === 'pr' ? 'pr checks' : (args[1] ?? '');
    if (path.includes('/check-runs') || refuse.some(part => path.includes(part))) throw new Error('gh api x: HTTP 403: Resource not accessible by personal access token');
    if (path === 'pr checks') return '[{"name":"gates","state":"SUCCESS"}]';
    if (path.startsWith(`repos/${REPO}/commits?`)) return '[{"sha":"0123456789abcdef"}]';
    if (path.includes('/status')) return '{"total_count":0,"statuses":[]}';
    if (path.includes('/actions/runs')) return '{"total_count":42,"workflow_runs":[]}';
    return '[]';
  });
}

test('describes the stored token by length and type prefix only', () => {
  const found = describeCredential({ kind: 'found', secret: SECRET });
  assert.equal(found, `teamrig-ship-gh: found, ${SECRET.length} chars, github_pat_ prefix`);
  assert.doesNotMatch(found, /SECRET/);
  assert.match(describeCredential({ kind: 'found', secret: 'abcdef' }), /an unknown prefix/);
  assert.match(describeCredential({ kind: 'missing' }), /not stored\. Store it \(prompts, nothing echoed\): cmdkey \/generic:teamrig-ship-gh \/user:teamrig \/pass$/);
  assert.equal(describeCredential({ kind: 'error', reason: 'powershell exited 1: x' }), 'teamrig-ship-gh: unreadable: powershell exited 1: x');
});

test('a token that reads all ship needs passes, with the check-runs refusal shown as expected', () => {
  const ghFor = mock.fn((_token: string) => fineGrainedGh());
  const { lines, ok } = tokenCheck({ kind: 'found', secret: SECRET }, ghFor, [REPO], 7);
  assert.equal(ok, true);
  assert.equal(ghFor.mock.calls[0]?.arguments[0], SECRET);
  assert.deepEqual(lines.slice(1), [
    `${REPO}: contents (Contents: read): yes, newest commit 0123456`,
    `${REPO}: pull requests (Pull requests: read): yes, 0 read`,
    `${REPO}: Actions runs (Actions: read): yes, 42 in all`,
    `${REPO}: commit statuses (Commit statuses: read): yes, 0 in all`,
    `${REPO}: check runs (no Checks permission on fine-grained tokens: ship reads Actions jobs instead): no: gh api x: HTTP 403: Resource not accessible by personal access token`,
    `${REPO}: gh pr checks 7: yes, 1 check(s) visible`,
    'writes (Contents, Pull requests: write) are not probed: the first merge proves them',
  ]);
  assert.ok(lines.every(line => !line.includes('SECRET')));
});

test('a needed read the token cannot do fails the check', () => {
  const { lines, ok } = tokenCheck({ kind: 'found', secret: SECRET }, () => fineGrainedGh(['/actions/runs']), [REPO], null);
  assert.equal(ok, false);
  assert.ok(lines.some(line => line.startsWith(`${REPO}: Actions runs (Actions: read): no:`)));
  assert.ok(!lines.some(line => line.includes('gh pr checks')));
});

test('a repo the token cannot see stops at the first read', () => {
  const { lines, ok } = tokenCheck({ kind: 'found', secret: SECRET }, () => fineGrainedGh([`repos/${REPO}/commits?`]), [REPO, REPO], null);
  assert.equal(ok, false);
  assert.equal(lines.filter(line => line.includes('contents (Contents: read): no')).length, 2);
  const empty = tokenCheck({ kind: 'found', secret: SECRET }, () => mock.fn<Gh>(() => '[]'), [REPO], null);
  assert.match(empty.lines[1] ?? '', /no: no commit to probe with/);
});

test('no stored token: one line saying how to store it, and a fail', () => {
  const ghFor = mock.fn((_token: string) => fineGrainedGh());
  assert.deepEqual(tokenCheck({ kind: 'missing' }, ghFor, [REPO], null).ok, false);
  assert.equal(ghFor.mock.callCount(), 0);
});

test('reads --repo and --pr, defaulting to every known repo', () => {
  assert.deepEqual(parseArgs([], ['A/b', 'C/d']), { repos: ['A/b', 'C/d'], pr: null });
  assert.deepEqual(parseArgs(['--repo', 'X/y', '--pr', '12'], ['A/b']), { repos: ['X/y'], pr: 12 });
  assert.throws(() => parseArgs(['--pr', 'twelve'], []), /usage: token-check\.ts/);
  assert.throws(() => parseArgs(['--repo'], []), /--repo needs a value/);
});
