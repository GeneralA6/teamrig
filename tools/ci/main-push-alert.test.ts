import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { AUTHOR } from '../lib/temp-repo.ts';
import {
  alertIssue,
  GITHUB_COMMITTER,
  mainPushFromEvent,
  mayBeOutsidePullRequest,
  mergedPullEndingOn,
  raiseMainPushAlert,
  type AlertIssue,
  type MainPush,
} from './main-push-alert.ts';

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);
const COMPARE = 'https://github.com/example/repo/compare/aaaa...bbbb';

/** A `push` event's payload with the fields the alert reads. */
function pushEvent(committer: string, forced = false): Record<string, unknown> {
  return { before: BEFORE, after: AFTER, forced, compare: COMPARE, pusher: { name: 'dana' }, head_commit: { committer: { email: committer } } };
}

const direct: MainPush = { pusher: 'dana', before: BEFORE, after: AFTER, forced: false, committer: AUTHOR.email, compare: COMPARE };

describe('mainPushFromEvent', () => {
  it('reads the pusher, the ends, the force flag, the head committer and the compare page', () => {
    assert.deepEqual(mainPushFromEvent(pushEvent(AUTHOR.email, true)), { ...direct, forced: true });
  });

  it('names an unknown pusher and no committer when the payload lacks them', () => {
    assert.deepEqual(mainPushFromEvent({ before: BEFORE, after: AFTER }), {
      pusher: 'an unknown account',
      before: BEFORE,
      after: AFTER,
      forced: false,
      committer: undefined,
      compare: undefined,
    });
  });

  it('refuses a payload that is not an object or has no ends', () => {
    assert.throws(() => mainPushFromEvent([]), /not a JSON object/);
    assert.throws(() => mainPushFromEvent({ before: BEFORE }), /no before and after shas/);
  });
});

describe('mayBeOutsidePullRequest', () => {
  it('lets a commit GitHub wrote pass, and flags any other committer or a force push', () => {
    assert.equal(mayBeOutsidePullRequest({ ...direct, committer: GITHUB_COMMITTER }), false);
    assert.equal(mayBeOutsidePullRequest(direct), true);
    assert.equal(mayBeOutsidePullRequest({ ...direct, committer: undefined }), true);
    assert.equal(mayBeOutsidePullRequest({ ...direct, committer: GITHUB_COMMITTER, forced: true }), true);
  });
});

describe('mergedPullEndingOn', () => {
  const merged = { number: 418, merged_at: '2026-11-01T12:46:00Z', merge_commit_sha: AFTER };

  it('names the merged pull request whose merge left main at the sha, as a rebase merge does', () => {
    assert.equal(mergedPullEndingOn([merged], AFTER), 418);
    assert.equal(mergedPullEndingOn([{ ...merged, number: 417, merge_commit_sha: BEFORE }, merged], AFTER), 418);
  });

  it('names none for an open pull request, one merged at another sha, or no pull request', () => {
    assert.equal(mergedPullEndingOn([{ ...merged, merged_at: null }], AFTER), undefined);
    assert.equal(mergedPullEndingOn([{ ...merged, merge_commit_sha: BEFORE }], AFTER), undefined);
    assert.equal(mergedPullEndingOn([], AFTER), undefined);
  });

  it('passes over an entry that is not an object or has no number', () => {
    assert.equal(mergedPullEndingOn(['418', { ...merged, number: '418' }], AFTER), undefined);
  });

  it('refuses an answer that is not a JSON array', () => {
    assert.throws(() => mergedPullEndingOn({ message: 'Not Found' }, AFTER), /not a JSON array/);
  });
});

describe('alertIssue', () => {
  it('names the pusher and the ends, and says how to undo the push', () => {
    const issue = alertIssue(direct);
    assert.equal(issue.title, 'Push to main outside a pull request, by dana');
    for (const part of [`- before: \`${BEFORE}\``, `- after: \`${AFTER}\``, '- forced: no', '- merged pull request ending on it: none', `- changes: ${COMPARE}`, 'npm install']) {
      assert.ok(issue.body.includes(part), part);
    }
  });

  it("prints no committer's e-mail address", () => {
    assert.ok(!alertIssue(direct).body.includes(AUTHOR.email));
  });

  it('marks a force push, and leaves out a compare page the event lacks', () => {
    const issue = alertIssue({ ...direct, forced: true, committer: undefined, compare: undefined });
    assert.equal(issue.title, 'Force push to main outside a pull request, by dana');
    assert.ok(issue.body.includes('- forced: yes'));
    assert.ok(!issue.body.includes('- changes:'));
  });
});

describe('raiseMainPushAlert', () => {
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: 'event.json' };

  /**
   * Runs the alert on one payload, with GitHub naming `pull` as the merged pull request ending on the push;
   * returns the exit code, the issues opened, the lines printed and the shas asked about.
   */
  async function alert(payload: unknown, pull?: number): Promise<{ code: number; issues: AlertIssue[]; lines: string[]; asked: string[] }> {
    const issues: AlertIssue[] = [];
    const lines: string[] = [];
    const asked: string[] = [];
    const code = await raiseMainPushAlert(
      env,
      async (path) => {
        assert.equal(path, 'event.json');
        return JSON.stringify(payload);
      },
      async (sha) => {
        asked.push(sha);
        return pull;
      },
      async (issue) => {
        issues.push(issue);
        return 'https://github.com/example/repo/issues/7\n';
      },
      (line) => lines.push(line),
    );
    return { code, issues, lines, asked };
  }

  it('opens one issue for a push no merged pull request ends on', async () => {
    const { code, issues, lines, asked } = await alert(pushEvent(AUTHOR.email));
    assert.equal(code, 0);
    assert.deepEqual(asked, [AFTER]);
    assert.deepEqual(issues, [alertIssue(direct)]);
    assert.deepEqual(lines, ['main-push-alert: opened https://github.com/example/repo/issues/7']);
  });

  it('opens none for a merge GitHub committed, without asking for its pull request', async () => {
    const { code, issues, lines, asked } = await alert(pushEvent(GITHUB_COMMITTER));
    assert.equal(code, 0);
    assert.deepEqual(asked, []);
    assert.deepEqual(issues, []);
    assert.deepEqual(lines, [`main-push-alert: ${AFTER} is a pull request merge, no alert`]);
  });

  it("opens none for a rebase merge, which keeps the merging account's committer", async () => {
    const { code, issues, lines } = await alert(pushEvent(AUTHOR.email), 418);
    assert.equal(code, 0);
    assert.deepEqual(issues, []);
    assert.deepEqual(lines, [`main-push-alert: ${AFTER} is the rebase merge of pull request #418, no alert`]);
  });

  it('opens one for a force push whatever pull request ends on it', async () => {
    const { issues, asked } = await alert(pushEvent(GITHUB_COMMITTER, true), 418);
    assert.deepEqual(asked, []);
    assert.deepEqual(issues, [alertIssue({ ...direct, committer: GITHUB_COMMITTER, forced: true })]);
  });

  it('refuses to run outside a push event', async () => {
    const never = async (): Promise<string> => assert.fail('nothing is read or opened');
    const noPull = async (): Promise<number> => assert.fail('no pull request is asked for');
    await assert.rejects(raiseMainPushAlert({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'event.json' }, never, noPull, never, () => {}), /needs a push event/);
    await assert.rejects(raiseMainPushAlert({ GITHUB_EVENT_NAME: 'push' }, never, noPull, never, () => {}), /needs a push event/);
  });
});

describe('main-push-alert.yml', () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const workflow = read('.github/workflows/main-push-alert.yml');

  it('runs on a push to main and starts a job only for a force push or a head commit GitHub did not write', () => {
    assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n/m);
    assert.match(workflow, new RegExp(`^ {4}if: github\\.event\\.forced \\|\\| github\\.event\\.head_commit\\.committer\\.email != '${GITHUB_COMMITTER.replaceAll('.', '\\.')}'$`, 'm'));
  });

  it('reads the repo and its pull requests, and writes only issues', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.match(workflow, /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {6}issues: write\n/m);
  });

  it("pins each action to the commit ci.yml pins it to, and puts no event text in a run line", () => {
    const ciUses = new Set(read('.github/workflows/ci.yml').match(/^\s*- uses: .+$/gm)?.map((line) => line.trim()));
    const uses = workflow.match(/^\s*- uses: .+$/gm)?.map((line) => line.trim()) ?? [];
    assert.equal(uses.length, 2);
    for (const line of uses) {
      assert.ok(ciUses.has(line), `${line} is not pinned as in ci.yml`);
    }
    const runs = workflow.match(/^\s*- run: .+$/gm)?.map((line) => line.trim()) ?? [];
    assert.deepEqual(runs, ['- run: node tools/ci/main-push-alert-cli.ts']);
    assert.ok(existsSync(new URL('./main-push-alert-cli.ts', import.meta.url)));
  });
});
