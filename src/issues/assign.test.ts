import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { assignIssue, loginRefusal, type AssignEnd, type AssignWrite } from './assign.ts';

const TARGET = { repo: 'acme/web', number: 7 };
const SHOWN = 'acme/web#7';

/** Runs `write` on `host`, giving how it ended and the lines it said. */
async function assign(host: FakeIssueHost, write: Omit<AssignWrite, 'target'>): Promise<{ end: AssignEnd; lines: string[] }> {
  const lines: string[] = [];
  const end = await assignIssue(host, { target: TARGET, ...write }, (line) => lines.push(line));
  return { end, lines };
}

describe('assignIssue', () => {
  it('reads the labels and each login on the item, assigns in one call as the host spells them, then takes off each to remove', async () => {
    const host = new FakeIssueHost().spells('OctoCat');
    assert.deepEqual(await assign(host, { add: ['octocat', 'hubot'], remove: ['mallory'] }), {
      end: 'done',
      lines: ['ACCESS acme: writes as the test', `ASSIGNED ${SHOWN}: OctoCat, hubot`, `UNASSIGNED ${SHOWN}: mallory`],
    });
    assert.deepEqual(host.labelReads, [TARGET]);
    assert.deepEqual(host.calls, [
      { kind: 'assign', target: TARGET, logins: ['OctoCat', 'hubot'] },
      { kind: 'unassign', target: TARGET, login: 'mallory' },
    ]);
  });

  it('assigns a commenter who took part in the item, though the repository-wide read would not take them', async () => {
    const host = new FakeIssueHost().tookPart('newcomer');
    assert.equal((await host.assigneeExists('acme/web', 'newcomer')).kind, 'missing');
    assert.equal((await assign(host, { add: ['newcomer'], remove: [] })).end, 'done');
    assert.deepEqual(host.calls, [{ kind: 'assign', target: TARGET, logins: ['newcomer'] }]);
  });

  it('only takes off with no add, reading no labels', async () => {
    const host = new FakeIssueHost().labelsItem(TARGET, 'design');
    assert.deepEqual(await assign(host, { add: [], remove: ['mallory'] }), { end: 'done', lines: ['ACCESS acme: writes as the test', `UNASSIGNED ${SHOWN}: mallory`] });
    assert.deepEqual(host.labelReads, []);
  });

  it('refuses an add to a design issue before any write', async () => {
    const host = new FakeIssueHost().labelsItem(TARGET, 'p2', 'design');
    const { end, lines } = await assign(host, { add: ['octocat'], remove: ['mallory'] });
    assert.equal(end, 'refused');
    assert.equal(lines.at(-1), `REFUSED ${SHOWN}: it is a design issue, talk and not work to take, so no one is assigned until it is agreed and the "design" label comes off; nothing was changed`);
    assert.deepEqual(host.calls, []);
  });

  it('assigns on an item whose other labels only look like design', async () => {
    const host = new FakeIssueHost().labelsItem(TARGET, 'design-system', 'Design');
    assert.equal((await assign(host, { add: ['octocat'], remove: [] })).end, 'done');
  });

  it('refuses a login the host may not assign to the item, sending no write, even after another login read well', async () => {
    const host = new FakeIssueHost().cannotAssign('ghost');
    const { end, lines } = await assign(host, { add: ['octocat', 'ghost'], remove: ['mallory'] });
    assert.equal(end, 'refused');
    assert.equal(lines.at(-1), `REFUSED ${SHOWN}: ghost may not be assigned to it: the test host assigns only someone with access to the repository, or someone who took part in the item; nothing was changed`);
    assert.deepEqual(host.calls, []);
  });

  it('fails with nothing changed when the host is unreachable, the item is missing, or a read fails', async () => {
    const unreachable = await assign(new FakeIssueHost().unreachable('no key for acme'), { add: ['octocat'], remove: [] });
    assert.deepEqual(unreachable, { end: 'failed', lines: [`FAILED ${SHOWN}: no key for acme; nothing was changed`] });
    const missing = await assign(new FakeIssueHost().readsIssueLabels({ kind: 'missing' }), { add: ['octocat'], remove: [] });
    assert.deepEqual(missing, { end: 'failed', lines: ['ACCESS acme: writes as the test', `FAILED ${SHOWN}: the test host shows no such issue or pull request; nothing was changed`] });
    const labels = await assign(new FakeIssueHost().readsIssueLabels({ kind: 'failed', reason: 'gh timed out' }), { add: ['octocat'], remove: [] });
    assert.equal(labels.lines.at(-1), `FAILED ${SHOWN}: gh timed out; nothing was changed`);
    const host = new FakeIssueHost().readsAssignee({ kind: 'failed', reason: 'gh exited 1' });
    assert.deepEqual(await assign(host, { add: ['octocat'], remove: [] }), { end: 'failed', lines: ['ACCESS acme: writes as the test', `FAILED ${SHOWN}: gh exited 1; nothing was changed`] });
    assert.deepEqual(host.calls, []);
  });

  it('says what was already done when a write fails after another', async () => {
    const first = await assign(new FakeIssueHost().failsAssign('HTTP 422'), { add: ['octocat'], remove: ['mallory'] });
    assert.deepEqual(first, { end: 'failed', lines: ['ACCESS acme: writes as the test', `FAILED ${SHOWN}: HTTP 422; nothing was changed`] });
    const later = await assign(new FakeIssueHost().failsUnassign('HTTP 500'), { add: ['octocat'], remove: ['mallory'] });
    assert.equal(later.end, 'failed');
    assert.equal(later.lines.at(-1), `FAILED ${SHOWN}: HTTP 500; it already assigned octocat`);
  });
});

describe('loginRefusal', () => {
  it('takes a login and refuses an empty one, one with a space or a control character, and one too long', () => {
    assert.equal(loginRefusal('octo-cat'), undefined);
    assert.equal(loginRefusal(''), 'a login is empty');
    assert.equal(loginRefusal('octo cat'), 'the login "octo cat" holds a space or a control character');
    assert.equal(loginRefusal('octo\u0007'), 'the login "octo\\u0007" holds a space or a control character');
    assert.match(loginRefusal('a'.repeat(101)) ?? '', /^the login "a+" is 101 characters, over the 100 a login may hold$/u);
  });
});
