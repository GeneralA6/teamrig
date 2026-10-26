import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { AUTHOR } from '../lib/temp-repo.ts';
import { alertIssue, GITHUB_COMMITTER, isOutsidePullRequest, mainPushFromEvent, raiseMainPushAlert, type AlertIssue, type MainPush } from './main-push-alert.ts';

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

describe('isOutsidePullRequest', () => {
  it('lets a commit GitHub wrote pass, and flags any other committer or a force push', () => {
    assert.equal(isOutsidePullRequest({ ...direct, committer: GITHUB_COMMITTER }), false);
    assert.equal(isOutsidePullRequest(direct), true);
    assert.equal(isOutsidePullRequest({ ...direct, committer: undefined }), true);
    assert.equal(isOutsidePullRequest({ ...direct, committer: GITHUB_COMMITTER, forced: true }), true);
  });
});

describe('alertIssue', () => {
  it('names the pusher and the ends, and says how to undo the push', () => {
    const issue = alertIssue(direct);
    assert.equal(issue.title, 'Push to main outside a pull request, by dana');
    for (const part of [`- before: \`${BEFORE}\``, `- after: \`${AFTER}\``, '- forced: no', `\`${AUTHOR.email}\``, `- changes: ${COMPARE}`, 'npm install']) {
      assert.ok(issue.body.includes(part), part);
    }
  });

  it('marks a force push, and leaves out a compare page the event lacks', () => {
    const issue = alertIssue({ ...direct, forced: true, committer: undefined, compare: undefined });
    assert.equal(issue.title, 'Force push to main outside a pull request, by dana');
    assert.ok(issue.body.includes('- forced: yes'));
    assert.ok(issue.body.includes('committer: `none`'));
    assert.ok(!issue.body.includes('- changes:'));
  });
});

describe('raiseMainPushAlert', () => {
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: 'event.json' };

  /** Runs the alert on one payload; returns the exit code, the issues opened and the lines printed. */
  async function alert(payload: unknown): Promise<{ code: number; issues: AlertIssue[]; lines: string[] }> {
    const issues: AlertIssue[] = [];
    const lines: string[] = [];
    const code = await raiseMainPushAlert(
      env,
      async (path) => {
        assert.equal(path, 'event.json');
        return JSON.stringify(payload);
      },
      async (issue) => {
        issues.push(issue);
        return 'https://github.com/example/repo/issues/7\n';
      },
      (line) => lines.push(line),
    );
    return { code, issues, lines };
  }

  it('opens one issue for a push outside a pull request', async () => {
    const { code, issues, lines } = await alert(pushEvent(AUTHOR.email));
    assert.equal(code, 0);
    assert.deepEqual(issues, [alertIssue(direct)]);
    assert.deepEqual(lines, ['main-push-alert: opened https://github.com/example/repo/issues/7']);
  });

  it('opens none for a pull request merge', async () => {
    const { code, issues, lines } = await alert(pushEvent(GITHUB_COMMITTER));
    assert.equal(code, 0);
    assert.deepEqual(issues, []);
    assert.deepEqual(lines, [`main-push-alert: ${AFTER} is a pull request merge, no alert`]);
  });

  it('refuses to run outside a push event', async () => {
    const never = async (): Promise<string> => assert.fail('nothing is read or opened');
    await assert.rejects(raiseMainPushAlert({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'event.json' }, never, never, () => {}), /needs a push event/);
    await assert.rejects(raiseMainPushAlert({ GITHUB_EVENT_NAME: 'push' }, never, never, () => {}), /needs a push event/);
  });
});

describe('main-push-alert.yml', () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const workflow = read('.github/workflows/main-push-alert.yml');

  it('runs on a push to main and starts a job only for a push outside a pull request, so a merge bills nothing', () => {
    assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n/m);
    assert.match(workflow, new RegExp(`^ {4}if: github\\.event\\.forced \\|\\| github\\.event\\.head_commit\\.committer\\.email != '${GITHUB_COMMITTER.replaceAll('.', '\\.')}'$`, 'm'));
  });

  it('reads the repo and writes only issues', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.match(workflow, /^ {4}permissions:\n {6}contents: read\n {6}issues: write\n/m);
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
