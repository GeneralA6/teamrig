import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Gh } from './github.ts';
import { arrayOf, booleanAt, listAt, recordAt, recordOf } from './json.ts';
import { findOpenPull, openPull, parsePull, rebaseMerge } from './pulls.ts';

const REPO = 'Owner/repo';
const pullJson = (number: number, sha: string): Record<string, unknown> => ({ number, html_url: `https://github.com/${REPO}/pull/${number}`, head: { ref: 'dev', sha }, base: { ref: 'main' } });

test('the JSON readers name what they read when a body has the wrong shape', () => {
  assert.throws(() => recordOf('[]', 'merge'), /merge: expected an object/);
  assert.throws(() => arrayOf('{}', 'open pull requests'), /open pull requests: expected a list/);
  assert.throws(() => listAt('[]', 'jobs', 'run jobs'), /run jobs: expected an object/);
  assert.throws(() => recordAt({ head: 'dev' }, 'head', 'pull request'), /pull request: "head" is not an object/);
  assert.throws(() => booleanAt({ merged: 'yes' }, 'merged', 'merge'), /merge: "merged" is not a boolean/);
  assert.deepEqual(arrayOf('[{"a":1}, 2, null]', 'x'), [{ a: 1 }]);
});

test('reads a pull request\'s number, link, head and base', () => {
  assert.deepEqual(parsePull(pullJson(4, 'abc')), { number: 4, url: `https://github.com/${REPO}/pull/4`, headRef: 'dev', headSha: 'abc', baseRef: 'main' });
  assert.throws(() => parsePull({ ...pullJson(4, 'abc'), head: { ref: 'dev' } }), /pull request head: "sha" is not a string/);
});

test('finds the open pull request from the branch of the repo itself', () => {
  const gh = mock.fn<Gh>(() => JSON.stringify([pullJson(4, 'abc')]));
  assert.equal(findOpenPull(gh, REPO, 'dev', 'main')?.number, 4);
  assert.deepEqual(gh.mock.calls[0]?.arguments[0], ['api', `repos/${REPO}/pulls?state=open&base=main&head=Owner:dev&per_page=10`]);
  assert.equal(findOpenPull(() => '[]', REPO, 'dev', 'main'), null);
  assert.throws(() => findOpenPull(() => JSON.stringify([pullJson(4, 'a'), pullJson(5, 'b')]), REPO, 'dev', 'main'), /2 open pull requests from dev into main/);
});

test('opens a pull request with raw string fields, so a body starting with @ is never read as a file', () => {
  const gh = mock.fn<Gh>(() => JSON.stringify(pullJson(9, 'abc')));
  assert.equal(openPull(gh, REPO, 'dev', 'main', 'Merge dev', '@etc/passwd\n- a').number, 9);
  assert.deepEqual(gh.mock.calls[0]?.arguments[0], ['api', `repos/${REPO}/pulls`, '-X', 'POST', '-f', 'title=Merge dev', '-f', 'head=dev', '-f', 'base=main', '-f', 'body=@etc/passwd\n- a']);
});

test('rebase-merges pinned to the checked sha, and reads a refusal', () => {
  const gh = mock.fn<Gh>(() => '{"sha":"merged1","merged":true,"message":"Pull Request successfully merged"}');
  assert.deepEqual(rebaseMerge(gh, REPO, 9, 'abc'), { merged: true, sha: 'merged1' });
  assert.deepEqual(gh.mock.calls[0]?.arguments[0], ['api', `repos/${REPO}/pulls/9/merge`, '-X', 'PUT', '-f', 'merge_method=rebase', '-f', 'sha=abc']);
  assert.deepEqual(rebaseMerge(() => '{"merged":false,"message":"Rebase failed"}', REPO, 9, 'abc'), { merged: false, message: 'Rebase failed' });
});
