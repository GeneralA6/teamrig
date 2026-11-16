import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { testTask } from '../testing/task.ts';
import { checkReply, closesIssue, sendReply, type ReplyWrite } from './reply.ts';
import { sessionLogins } from './status-push.ts';

const TARGET = { repo: 'acme/web', number: 922 };
const LOGINS = sessionLogins({ octocat: 'bravo' });

/** Runs the reads, then the send, as `issue reply` does once the register is set; the lines said, and the end. */
async function reply(host: FakeIssueHost, write: ReplyWrite, status: 'open' | 'verifying' | 'done' = 'verifying'): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
  };
  const check = await checkReply(host, write, say);
  if (check.kind === 'refused') {
    lines.push(`REFUSED ${check.reason}`);
    return { lines, ok: false };
  }
  const task = testTask({ id: 'T5', owner: 'bravo', status, ref: 'gh:acme/web#922' });
  return { lines, ok: await sendReply(host, write, check.reads, task, LOGINS, say) };
}

describe('issue reply (T3169)', () => {
  it('on #922 sets the state the words name before the words: status, the answering pull request linked and labelled, the follow-up, then the comment', async () => {
    const host = new FakeIssueHost()
      .hasLabels('status:in review')
      .holdsThread(922, { labels: ['bug', 'area:github', 'status:open'] })
      .holdsThread(1272, { pull: true, body: 'Adds the reply.' });
    const body = 'Answered by #1272; this closes when it lands, and the rest goes to its own issue.';
    const { lines, ok } = await reply(host, { target: TARGET, body, pull: 1272, followup: { title: 'The rest of the reply', body: 'What is left.' }, assign: [] });
    assert.ok(ok, lines.join('\n'));
    assert.deepEqual(lines, [
      'ACCESS acme: writes as the test',
      'SET acme/web#922 T5 verifying: add status:in review, take off status:open, assign octocat',
      'LINKED acme/web#1272: its body now closes #922',
      'LABELED acme/web#1272: "bug", "area:github"',
      'OPENED acme/web#1: the follow-up of acme/web#922',
      'COMMENTED acme/web#922',
    ]);
    assert.deepEqual(
      host.calls.map((call) => call.kind),
      ['label-add', 'label-remove', 'assign', 'body', 'label-add', 'open', 'comment'],
    );
    const last = host.calls.at(-1);
    assert.ok(last?.kind === 'comment' && last.body === `${body}\n\nFollow-up: #1`);
    const edit = host.calls.find((call) => call.kind === 'body');
    assert.ok(edit?.kind === 'body' && edit.body === 'Adds the reply.\n\nCloses #922');
    const opened = host.calls.find((call) => call.kind === 'open');
    assert.ok(opened?.kind === 'open' && opened.draft.body === 'What is left.\n\nSplit from #922.');
  });

  it('posts no comment when a state write fails, saying what was already done', async () => {
    const host = new FakeIssueHost().hasLabels('status:in review').holdsThread(1272, { pull: true }).failsBody('HTTP 403');
    const { lines, ok } = await reply(host, { target: TARGET, body: 'Answered by #1272.', pull: 1272, assign: [] });
    assert.equal(ok, false);
    assert.equal(lines.at(-1), 'FAILED acme/web#922: HTTP 403; it already shows verifying; the comment was not posted');
    assert.ok(!host.calls.some((call) => call.kind === 'comment'));
  });

  it('replies on a labelled pull request with no status of its own: no task, no status write, the comment', async () => {
    const host = new FakeIssueHost().holdsThread(922, { pull: true, labels: ['bug'] });
    const lines: string[] = [];
    const write: ReplyWrite = { target: TARGET, body: 'Thanks, landing it.', assign: [] };
    const check = await checkReply(host, write, (line) => lines.push(line));
    assert.ok(check.kind === 'read');
    assert.ok(await sendReply(host, write, check.reads, undefined, LOGINS, (line) => lines.push(line)));
    assert.deepEqual(host.calls.map((call) => call.kind), ['comment']);
  });

  it('refuses, writing nothing, a bare pull request, --pr on a pull request, an issue as --pr, a closed --pr, an unassignable login and an unread issue', async () => {
    const cases: Array<[FakeIssueHost, Partial<ReplyWrite>, RegExp]> = [
      [new FakeIssueHost().holdsThread(922, { pull: true }), {}, /acme\/web#922 has no labels: label it first/u],
      [new FakeIssueHost().holdsThread(922, { pull: true, labels: ['bug'] }), { pull: 5 }, /acme\/web#922 is a pull request: --pr names/u],
      [new FakeIssueHost(), { pull: 5 }, /acme\/web#5 is an issue, not a pull request/u],
      [new FakeIssueHost().holdsThread(5, { pull: true, state: 'closed' }), { pull: 5 }, /acme\/web#5 is closed/u],
      [new FakeIssueHost().cannotAssign('ghost'), { assign: ['ghost'] }, /ghost may not be assigned in acme\/web/u],
      [new FakeIssueHost().readsThread({ kind: 'missing' }), {}, /acme\/web#922 is no issue or pull request the access can see/u],
      [new FakeIssueHost().readsThread({ kind: 'failed', reason: 'HTTP 502' }), {}, /HTTP 502/u],
    ];
    for (const [host, write, error] of cases) {
      const { lines, ok } = await reply(host, { target: TARGET, body: 'x', assign: [], ...write });
      assert.equal(ok, false);
      assert.match(lines.at(-1) ?? '', error);
      assert.deepEqual(host.calls, []);
    }
  });

  it('assigns each login not yet on the issue, as the host spells it, and adds no closing line a pull request already has', async () => {
    const host = new FakeIssueHost()
      .spells('MonaLisa')
      .holdsThread(922, { labels: ['status:claimed'], assignees: ['octocat'] })
      .holdsThread(7, { pull: true, body: 'Fixes: acme/web#922', labels: [] });
    const { lines, ok } = await reply(host, { target: TARGET, body: 'Yours, thanks.', pull: 7, assign: ['monalisa', 'octocat'] }, 'open');
    assert.ok(ok, lines.join('\n'));
    assert.deepEqual(host.calls.map((call) => call.kind), ['assign', 'comment']);
    assert.ok(host.calls[0]?.kind === 'assign' && host.calls[0].logins.join() === 'MonaLisa');
  });

  it('refuses a reply on a closed issue whose task is still active, posting nothing', async () => {
    const host = new FakeIssueHost().holdsThread(922, { state: 'closed' });
    const { lines, ok } = await reply(host, { target: TARGET, body: 'x', assign: [] });
    assert.equal(ok, false);
    assert.equal(lines.at(-1), 'FAILED acme/web#922: acme/web#922 is closed while T5 is verifying: reopen it, or end the task, before replying; the comment was not posted');
    assert.deepEqual(host.calls, []);
  });
});

describe('closesIssue (T3169)', () => {
  it('reads each closing keyword form GitHub does, and no other number or word', () => {
    for (const body of ['Closes #922', 'fixes: #922', 'Resolved acme/web#922.', 'fix https://github.com/acme/web/issues/922', 'x\nCLOSE #922']) {
      assert.ok(closesIssue(body, TARGET), body);
    }
    for (const body of ['Closes #9220', 'Refs #922', 'closes #92', 'Closes other/web#922', 'Disclosed #922']) {
      assert.ok(!closesIssue(body, TARGET), body);
    }
  });

  it('reads a repository name with a dot as written, the dot matching only a dot', () => {
    const dotted = { repo: 'acme/web.site', number: 922 };
    assert.ok(closesIssue('Closes acme/web.site#922', dotted));
    assert.ok(!closesIssue('Closes acme/webXsite#922', dotted));
    assert.ok(!closesIssue('fix https://github.com/acme/webXsite/issues/922', dotted));
  });
});
