import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { editIssueBody, labelIssue, labelRefusal, MAX_COMMENT, MAX_LABEL, postRefusal, writeIssue, type IssueWrite, type LabelWrite } from './write.ts';

const TARGET = { repo: 'acme/web', number: 7 };

/** Runs `write` on `host`, giving whether every step was done and the lines it said. */
async function run(host: FakeIssueHost, write: IssueWrite): Promise<{ done: boolean; lines: string[] }> {
  const lines: string[] = [];
  const done = await writeIssue(host, write, (line) => lines.push(line));
  return { done, lines };
}

/** Runs `write` as a label change on `host`, giving whether every step was done and the lines it said. */
async function label(host: FakeIssueHost, write: Omit<LabelWrite, 'target'>): Promise<{ done: boolean; lines: string[] }> {
  const lines: string[] = [];
  const done = await labelIssue(host, { target: TARGET, ...write }, (line) => lines.push(line));
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

  it('closes with the reason given, and says it', async () => {
    const host = new FakeIssueHost();
    assert.deepEqual((await run(host, { target: TARGET, close: true, reason: 'not-planned' })).lines, ['ACCESS acme: writes as the test', 'CLOSED acme/web#7 as not-planned']);
    assert.deepEqual(host.calls, [{ kind: 'close', target: TARGET, reason: 'not-planned' }]);
  });

  it('only comments, or only closes, as asked', async () => {
    const commenting = new FakeIssueHost();
    assert.equal((await run(commenting, { target: TARGET, comment: 'Thanks', close: false })).done, true);
    assert.deepEqual(commenting.calls.map((call) => call.kind), ['comment']);
    const closing = new FakeIssueHost();
    assert.deepEqual((await run(closing, { target: TARGET, close: true })).lines, ['ACCESS acme: writes as the test', 'CLOSED acme/web#7']);
    assert.deepEqual(closing.calls.map((call) => call.kind), ['close']);
  });

  it('closes as a duplicate, naming the original by the host id read for it before anything is written', async () => {
    const host = new FakeIssueHost();
    const write: IssueWrite = { target: TARGET, comment: 'Same as #3.', close: true, reason: 'duplicate', duplicateOf: { repo: 'acme/web', number: 3 } };
    assert.deepEqual(await run(host, write), {
      done: true,
      lines: ['ACCESS acme: writes as the test', 'COMMENTED acme/web#7', 'CLOSED acme/web#7 as duplicate of acme/web#3'],
    });
    assert.deepEqual(host.calls, [{ kind: 'comment', target: TARGET, body: 'Same as #3.' }, { kind: 'close', target: TARGET, reason: 'duplicate', duplicateId: 1003 }]);
  });

  it('writes nothing, not even the comment, when the original is missing or its read fails', async () => {
    const write: IssueWrite = { target: TARGET, comment: 'Same as #3.', close: true, reason: 'duplicate', duplicateOf: { repo: 'acme/web', number: 3 } };
    const missing = new FakeIssueHost().readsId({ kind: 'missing' });
    assert.deepEqual(await run(missing, write), {
      done: false,
      lines: ['ACCESS acme: writes as the test', 'FAILED acme/web#7: acme/web#3 is no issue the access can see: name an existing one as the original; nothing was written'],
    });
    assert.deepEqual(missing.calls, []);
    const failing = new FakeIssueHost().readsId({ kind: 'failed', reason: 'gh: HTTP 502' });
    assert.deepEqual((await run(failing, write)).lines.slice(1), ['FAILED acme/web#7: gh: HTTP 502; nothing was written']);
    assert.deepEqual(failing.calls, []);
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

describe('editIssueBody', () => {
  /** Runs a body edit of TARGET on `host`, giving whether it was done and the lines it said. */
  async function edit(host: FakeIssueHost, body: string): Promise<{ done: boolean; lines: string[] }> {
    const lines: string[] = [];
    const done = await editIssueBody(host, { target: TARGET, body }, (line) => lines.push(line));
    return { done, lines };
  }

  it('replaces the body, saying how the host was reached and the new length', async () => {
    const host = new FakeIssueHost();
    assert.deepEqual(await edit(host, '## Spec'), { done: true, lines: ['ACCESS acme: writes as the test', 'EDITED acme/web#7: its body is now 7 characters'] });
    assert.deepEqual(host.calls, [{ kind: 'body', target: TARGET, body: '## Spec' }]);
  });

  it('changes nothing when the host cannot be reached, and says the body stayed when the edit fails', async () => {
    const unreachable = new FakeIssueHost().unreachable('the keyring is locked');
    assert.deepEqual(await edit(unreachable, 'b'), { done: false, lines: ['FAILED acme/web#7: the keyring is locked; nothing was changed'] });
    assert.deepEqual(unreachable.calls, []);
    const refused = new FakeIssueHost().failsBody('HTTP 403');
    assert.deepEqual(await edit(refused, 'b'), { done: false, lines: ['ACCESS acme: writes as the test', 'FAILED acme/web#7: HTTP 403; the body is as it was'] });
  });
});

describe('labelRefusal', () => {
  it('takes a label with spaces, colons, emoji and the longest length', () => {
    for (const name of ['type: bug', 'good first issue', 'p1', '🐛 bug', 'x'.repeat(MAX_LABEL)]) {
      assert.equal(labelRefusal(name), undefined, name);
    }
  });

  it('refuses an empty, padded, too long or control-character name', () => {
    assert.equal(labelRefusal(' '), 'a label name is empty');
    assert.equal(labelRefusal('\tp1'), 'the label "\\tp1" holds a control character');
    assert.equal(labelRefusal(' p1'), 'the label " p1" starts or ends with a space');
    assert.match(labelRefusal('x'.repeat(MAX_LABEL + 1)) ?? '', /is 51 characters, over the 50 a label may hold$/u);
    assert.equal(labelRefusal('p1\n'), 'the label "p1\\n" holds a control character');
  });
});

describe('labelIssue', () => {
  it('reads that each label to add is there, adds them in one call, then takes off each to remove', async () => {
    const host = new FakeIssueHost().hasLabels('type: bug', 'p1');
    assert.deepEqual(await label(host, { add: ['type: bug', 'p1'], remove: ['needs triage', 'p2'] }), {
      done: true,
      lines: ['ACCESS acme: writes as the test', 'LABELED acme/web#7: "type: bug", "p1"', 'UNLABELED acme/web#7: "needs triage"', 'UNLABELED acme/web#7: "p2"'],
    });
    assert.deepEqual(host.calls, [
      { kind: 'label-add', target: TARGET, labels: ['type: bug', 'p1'] },
      { kind: 'label-remove', target: TARGET, label: 'needs triage' },
      { kind: 'label-remove', target: TARGET, label: 'p2' },
    ]);
  });

  it('makes a label teamrig manages that the repository lacks, then adds it (T3096)', async () => {
    const host = new FakeIssueHost().hasLabels('p2');
    assert.deepEqual(await label(host, { add: ['design', 'p2'], remove: [] }), {
      done: true,
      lines: ['ACCESS acme: writes as the test', 'MADE acme/web: the label "design", one teamrig makes', 'LABELED acme/web#7: "design", "p2"'],
    });
    assert.deepEqual(host.calls, [
      { kind: 'label-create', repo: 'acme/web', label: { name: 'design', color: 'd4c5f9', description: 'Design talk: discussion only, not work to take until it is agreed' } },
      { kind: 'label-add', target: TARGET, labels: ['design', 'p2'] },
    ]);
  });

  it('names the label it made when the add after it fails, as a made label stays in the repository', async () => {
    const refused = new FakeIssueHost().failsLabel('HTTP 403');
    assert.deepEqual((await label(refused, { add: ['design'], remove: [] })).lines.slice(1), [
      'MADE acme/web: the label "design", one teamrig makes',
      'FAILED acme/web#7: HTTP 403; it already made the label "design"',
    ]);
  });

  it('changes nothing on the issue when the make fails, nor when a managed label is asked in another case', async () => {
    const refused = new FakeIssueHost().failsLabelCreate('HTTP 403');
    assert.deepEqual((await label(refused, { add: ['design'], remove: [] })).lines.slice(1), ['FAILED acme/web#7: HTTP 403; nothing was changed']);
    assert.deepEqual(refused.calls.map((call) => call.kind), ['label-create']);
    const cased = new FakeIssueHost();
    assert.deepEqual((await label(cased, { add: ['Design'], remove: [] })).lines.slice(1), [
      'FAILED acme/web#7: acme/web has no label "Design": make it there first, as adding it here would make a new one; nothing was changed',
    ]);
    assert.deepEqual(cased.calls, []);
  });

  it('changes nothing when a label to add is not one of the repository, or its read fails', async () => {
    const typo = new FakeIssueHost().hasLabels('p1');
    assert.deepEqual(await label(typo, { add: ['p1', 'tpye: bug'], remove: ['p2'] }), {
      done: false,
      lines: ['ACCESS acme: writes as the test', 'FAILED acme/web#7: acme/web has no label "tpye: bug": make it there first, as adding it here would make a new one; nothing was changed'],
    });
    assert.deepEqual(typo.calls, []);
    const unread = new FakeIssueHost().failsLabelRead('HTTP 502');
    assert.deepEqual((await label(unread, { add: ['p1'], remove: [] })).lines.slice(1), ['FAILED acme/web#7: HTTP 502; nothing was changed']);
    assert.deepEqual(unread.calls, []);
  });

  it('changes nothing when the host cannot be reached or the add fails', async () => {
    const locked = new FakeIssueHost().unreachable('the keyring is locked');
    assert.deepEqual((await label(locked, { add: [], remove: ['p1'] })).lines, ['FAILED acme/web#7: the keyring is locked; nothing was changed']);
    const refused = new FakeIssueHost().hasLabels('p1').failsLabel('HTTP 403');
    assert.deepEqual((await label(refused, { add: ['p1'], remove: ['p2'] })).lines.slice(1), ['FAILED acme/web#7: HTTP 403; nothing was changed']);
    assert.deepEqual(refused.calls.map((call) => call.kind), ['label-add']);
  });

  it('says what it already did when taking a label off fails', async () => {
    const host = new FakeIssueHost().failsRemove('p2', 'acme/web#7 does not carry the label "p2", or is not there');
    assert.deepEqual((await label(host, { add: [], remove: ['p2'] })).lines.slice(1), ['FAILED acme/web#7: acme/web#7 does not carry the label "p2", or is not there']);
    const after = new FakeIssueHost().hasLabels('p1').failsRemove('p3', 'HTTP 502');
    assert.deepEqual((await label(after, { add: ['p1'], remove: ['p2', 'p3'] })).lines.slice(2), [
      'UNLABELED acme/web#7: "p2"',
      'FAILED acme/web#7: HTTP 502; it already added "p1", took off "p2"',
    ]);
  });
});
