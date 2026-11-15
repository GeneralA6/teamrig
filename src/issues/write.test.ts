import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { MAX_COMMENT, postRefusal, writeIssue, type IssueWrite } from './write.ts';

const TARGET = { repo: 'acme/web', number: 7 };

/** Runs `write` on `host`, giving whether every step was done and the lines it said. */
async function run(host: FakeIssueHost, write: IssueWrite): Promise<{ done: boolean; lines: string[] }> {
  const lines: string[] = [];
  const done = await writeIssue(host, write, (line) => lines.push(line));
  return { done, lines };
}

describe('postRefusal', () => {
  /** Built at runtime so no secret-shaped literal sits in the source. */
  const secret = ['tok', '_abcd1234'].join('');
  const scanner = new SecretScanner(['tok_[a-z0-9]{8}']);

  it('takes plain text, links and pull request numbers among it', () => {
    assert.equal(postRefusal('--body', 'Thank you! Merged as #624 (plugin 0.353.2).', scanner), undefined);
  });

  it('refuses an empty text, one too long, a secret shape and a task id, naming the shape but never the text', () => {
    assert.equal(postRefusal('--body', '  \n', scanner), '--body is empty');
    assert.match(postRefusal('--body', 'x'.repeat(MAX_COMMENT + 1), scanner) ?? '', /^--body is 65537 characters, over the 65536/u);
    const refused = postRefusal('--body', `key ${secret}`, scanner) ?? '';
    assert.match(refused, /^--body looks like it holds a secret/u);
    assert.ok(!refused.includes(secret));
    assert.match(postRefusal('--body', 'Done in T12.', scanner) ?? '', /^--body names the task id T12/u);
  });

  it('refuses private data, naming its shape but never the text', () => {
    /** Built at runtime so no private-shaped literal sits in the source. */
    const home = ['/', 'home/dana/notes'].join('');
    const mail = ['dana', '@', 'acme.io'].join('');
    assert.equal(postRefusal('--body', `see ${home}`, scanner), '--body holds private data (absolute path inside a user home folder): take it out, as a post may be read by anyone');
    const refused = postRefusal('--comment', `write to ${mail}`, scanner) ?? '';
    assert.equal(refused, '--comment holds private data (e-mail address): take it out, as a post may be read by anyone');
    assert.ok(!refused.includes(mail));
  });
});

describe('writeIssue', () => {
  it('comments, then closes, saying how the host was reached', async () => {
    const host = new FakeIssueHost();
    assert.deepEqual(await run(host, { target: TARGET, comment: 'Thanks', close: true }), {
      done: true,
      lines: ['ACCESS acme: writes as the test', 'COMMENTED acme/web#7', 'CLOSED acme/web#7'],
    });
    assert.deepEqual(host.calls, [{ kind: 'comment', target: TARGET, body: 'Thanks' }, { kind: 'close', target: TARGET }]);
  });

  it('only comments, or only closes, as asked', async () => {
    const commenting = new FakeIssueHost();
    assert.equal((await run(commenting, { target: TARGET, comment: 'Thanks', close: false })).done, true);
    assert.deepEqual(commenting.calls.map((call) => call.kind), ['comment']);
    const closing = new FakeIssueHost();
    assert.deepEqual((await run(closing, { target: TARGET, close: true })).lines, ['ACCESS acme: writes as the test', 'CLOSED acme/web#7']);
    assert.deepEqual(closing.calls.map((call) => call.kind), ['close']);
  });

  it('writes nothing when the host cannot be reached', async () => {
    const host = new FakeIssueHost().unreachable('the keyring is locked');
    assert.deepEqual(await run(host, { target: TARGET, comment: 'Thanks', close: true }), {
      done: false,
      lines: ['FAILED acme/web#7: the keyring is locked; nothing was written'],
    });
    assert.deepEqual(host.calls, []);
  });

  it('closes nothing when the comment fails', async () => {
    const host = new FakeIssueHost().failsComment('HTTP 403');
    assert.deepEqual((await run(host, { target: TARGET, comment: 'Thanks', close: true })).lines.slice(1), ['FAILED acme/web#7: HTTP 403; it was not closed']);
    assert.deepEqual(host.calls.map((call) => call.kind), ['comment']);
  });

  it('says the comment was posted when the close after it fails, so a rerun does not post it twice', async () => {
    const host = new FakeIssueHost().failsClose('HTTP 403');
    assert.deepEqual((await run(host, { target: TARGET, comment: 'Thanks', close: true })).lines.slice(1), [
      'COMMENTED acme/web#7',
      'FAILED acme/web#7: HTTP 403; the comment was posted: rerun teamrig issue close acme/web#7 without --comment',
    ]);
    assert.deepEqual((await run(new FakeIssueHost().failsClose('HTTP 403'), { target: TARGET, close: true })).lines.slice(1), ['FAILED acme/web#7: HTTP 403']);
  });
});
