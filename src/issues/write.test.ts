import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { codeHostOnly, trackerOnly } from '../testing/split-hosts.ts';
import { areaLabelSpec } from './managed-labels.ts';
import { editIssueBody, labelIssue, labelRefusal, MAX_COMMENT, MAX_LABEL, postRefusal, writeIssue, type IssueWrite, type LabelWrite } from './write.ts';

const TARGET = { repo: 'acme/web', number: 7 };

/** Runs `write` on `host`, giving whether every step was done and the lines it said. */
async function run(host: FakeIssueHost, write: IssueWrite): Promise<{ done: boolean; lines: string[] }> {
  const lines: string[] = [];
  const done = await writeIssue(host, write, (line) => lines.push(line));
  return { done, lines };
}

/**
 * Runs `write` as a label change on `host`, as the tracker and the code host both, giving whether every step was done
 * and the lines it said.
 */
async function label(host: FakeIssueHost, write: Omit<LabelWrite, 'target'>): Promise<{ done: boolean; lines: string[] }> {
  const lines: string[] = [];
  const done = await labelIssue(host, host, { target: TARGET, ...write }, (line) => lines.push(line));
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
      'FAILED acme/web#7: acme/web has no label "Design", and it has no .github/labels.json: add it to that file or make it there first, as adding it here would make a new one; nothing was changed',
    ]);
    assert.deepEqual(cased.calls, []);
  });

  it("makes a label the repository's label file names, as that file spells it, reading the file once (T3198)", async () => {
    const area = { name: 'area:cli', color: '1d76db', description: 'Area: the command line' };
    const docs = { name: 'area:docs', color: '0e8a16', description: 'Area: the docs' };
    const host = new FakeIssueHost().hasLabels('p2').holdsLabelFile('acme/web', { kind: 'read', labels: [area, docs] });
    assert.deepEqual(await label(host, { add: ['Area:CLI', 'p2', 'area:docs'], remove: [] }), {
      done: true,
      lines: [
        'ACCESS acme: writes as the test',
        'MADE acme/web: the label "area:cli", as its .github/labels.json names it',
        'MADE acme/web: the label "area:docs", as its .github/labels.json names it',
        'LABELED acme/web#7: "Area:CLI", "p2", "area:docs"',
      ],
    });
    assert.deepEqual(host.calls.slice(0, 2), [
      { kind: 'label-create', repo: 'acme/web', label: area },
      { kind: 'label-create', repo: 'acme/web', label: docs },
    ]);
    assert.deepEqual(host.labelFileReads, ['acme/web']);
  });

  it("makes a missing label the team's github.areaOwners names in the area look, its label file's spec first (T4053)", async () => {
    const host = new FakeIssueHost().hasLabels('p2');
    assert.deepEqual(await label(host, { add: ['Area:Pane', 'p2'], remove: [], areaLabels: ['area:pane'] }), {
      done: true,
      lines: ['ACCESS acme: writes as the test', `MADE acme/web: the label "area:pane", as the team config's github.areaOwners names it`, 'LABELED acme/web#7: "Area:Pane", "p2"'],
    });
    assert.deepEqual(host.calls[0], { kind: 'label-create', repo: 'acme/web', label: areaLabelSpec('area:pane') });
    const filed = { name: 'area:pane', color: '1d76db', description: 'Area: the pane' };
    const both = new FakeIssueHost().holdsLabelFile('acme/web', { kind: 'read', labels: [filed] });
    assert.equal((await label(both, { add: ['area:pane'], remove: [], areaLabels: ['area:pane'] })).done, true);
    assert.deepEqual(both.calls[0], { kind: 'label-create', repo: 'acme/web', label: filed });
  });

  it('makes no area label the repository has, nor one github.areaOwners does not name (T4053)', async () => {
    const has = new FakeIssueHost().hasLabels('area:pane');
    assert.equal((await label(has, { add: ['area:pane'], remove: [], areaLabels: ['area:pane'] })).done, true);
    assert.ok(has.calls.every((call) => call.kind !== 'label-create'));
    const other = new FakeIssueHost();
    assert.deepEqual((await label(other, { add: ['area:cli'], remove: [], areaLabels: ['area:pane'] })).lines.slice(1), [
      'FAILED acme/web#7: acme/web has no label "area:cli", and it has no .github/labels.json: add it to that file or make it there first, as adding it here would make a new one; nothing was changed',
    ]);
    assert.deepEqual(other.calls, []);
  });

  it('reads no label file for a label the repository has or one teamrig makes', async () => {
    const host = new FakeIssueHost().hasLabels('p1');
    assert.equal((await label(host, { add: ['p1', 'design'], remove: [] })).done, true);
    assert.deepEqual(host.labelFileReads, []);
  });

  it("changes nothing for a missing label the file does not name, nor when the file's read fails", async () => {
    const other = new FakeIssueHost().holdsLabelFile('acme/web', { kind: 'read', labels: [{ name: 'area:cli', color: '1d76db', description: 'x' }] });
    assert.deepEqual((await label(other, { add: ['area:cl'], remove: [] })).lines.slice(1), [
      'FAILED acme/web#7: acme/web has no label "area:cl", and its .github/labels.json does not name it: add it to that file or make it there first, as adding it here would make a new one; nothing was changed',
    ]);
    assert.deepEqual(other.calls, []);
    const broken = new FakeIssueHost().holdsLabelFile('acme/web', { kind: 'failed', reason: 'the .github/labels.json of acme/web does not parse: x' });
    assert.deepEqual((await label(broken, { add: ['area:cli'], remove: [] })).lines.slice(1), ['FAILED acme/web#7: the .github/labels.json of acme/web does not parse: x; nothing was changed']);
    assert.deepEqual(broken.calls, []);
  });

  it('changes nothing when a label to add is not one of the repository, or its read fails', async () => {
    const typo = new FakeIssueHost().hasLabels('p1');
    assert.deepEqual(await label(typo, { add: ['p1', 'tpye: bug'], remove: ['p2'] }), {
      done: false,
      lines: ['ACCESS acme: writes as the test', 'FAILED acme/web#7: acme/web has no label "tpye: bug", and it has no .github/labels.json: add it to that file or make it there first, as adding it here would make a new one; nothing was changed'],
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

  it('names each label as the tracker holds it before it looks for it, makes it, adds it or takes it off (T4754)', async () => {
    const hyphens = (name: string): string => name.replace(/\s+/gu, '-');
    const host = new FakeIssueHost().namesLabels(hyphens).hasLabels('good-first-issue');
    assert.deepEqual(await label(host, { add: ['good first issue'], remove: ['needs info'] }), {
      done: true,
      lines: ['ACCESS acme: writes as the test', 'LABELED acme/web#7: "good-first-issue"', 'UNLABELED acme/web#7: "needs-info"'],
    });
    assert.deepEqual(host.calls, [
      { kind: 'label-add', target: TARGET, labels: ['good-first-issue'] },
      { kind: 'label-remove', target: TARGET, label: 'needs-info' },
    ]);
    const lacking = new FakeIssueHost().namesLabels(hyphens);
    assert.deepEqual((await label(lacking, { add: ['status:in progress'], remove: [] })).lines.slice(1), [
      'MADE acme/web: the label "status:in-progress", one teamrig makes',
      'LABELED acme/web#7: "status:in-progress"',
    ]);
    assert.deepEqual(lacking.calls[0], { kind: 'label-create', repo: 'acme/web', label: { name: 'status:in-progress', color: '8957e5', description: 'Work on it is under way' } });
    const filed = new FakeIssueHost().namesLabels(hyphens).holdsLabelFile('acme/web', { kind: 'read', labels: [{ name: 'needs info', color: 'd876e3', description: 'More is needed' }] });
    assert.equal((await label(filed, { add: ['needs info'], remove: [] })).done, true);
    assert.deepEqual(filed.calls[0], { kind: 'label-create', repo: 'acme/web', label: { name: 'needs-info', color: 'd876e3', description: 'More is needed' } });
  });

  it('reads the label file from the code host and writes the labels on the tracker, when they are two hosts (T4619)', async () => {
    const area = { name: 'area:cli', color: '1d76db', description: 'Area: the command line' };
    const tracker = new FakeIssueHost();
    const code = new FakeIssueHost().holdsLabelFile('acme/web', { kind: 'read', labels: [area] });
    const lines: string[] = [];
    const done = await labelIssue(trackerOnly(tracker), codeHostOnly(code), { target: TARGET, add: ['area:cli'], remove: [] }, (line) => lines.push(line));
    assert.deepEqual([done, lines], [true, ['ACCESS acme: writes as the test', 'MADE acme/web: the label "area:cli", as its .github/labels.json names it', 'LABELED acme/web#7: "area:cli"']]);
    assert.deepEqual([tracker.labelFileReads, code.labelFileReads], [[], ['acme/web']]);
    assert.deepEqual(tracker.calls, [
      { kind: 'label-create', repo: 'acme/web', label: area },
      { kind: 'label-add', target: TARGET, labels: ['area:cli'] },
    ]);
    assert.deepEqual(code.calls, []);
  });
});

describe('a write on a tracker that is no code host (T4619)', () => {
  it('comments, closes as a duplicate and edits the body with the tracker alone', async () => {
    const host = new FakeIssueHost();
    const lines: string[] = [];
    const original = { repo: 'acme/web', number: 3 };
    assert.equal(await writeIssue(trackerOnly(host), { target: TARGET, comment: 'Thanks', close: true, reason: 'duplicate', duplicateOf: original }, (line) => lines.push(line)), true);
    assert.equal(await editIssueBody(trackerOnly(host), { target: TARGET, body: '## Spec' }, (line) => lines.push(line)), true);
    assert.deepEqual(
      host.calls.map((call) => call.kind),
      ['comment', 'close', 'body'],
    );
  });
});
