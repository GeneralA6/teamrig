import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { isIssueQuery, isViewerRead } from '../adapters/connectors/github/gh.ts';
import { PUSH_WRITES_PER_RUN } from '../issues/status-push.ts';
import { CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeGh, ghIssue, ghPull } from '../testing/fake-gh.ts';
import { SHOWN_CHANGES } from './commands/issue-push.ts';
import { USAGE } from './run.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'], owners: { octocat: 'bravo' } } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const AS_BRAVO = { env: { TEAMRIG_SESSION: 'bravo' } };

/** What a run that reads acme's repositories with no token saved prints first. */
const NO_TOKEN = 'ACCESS acme: read with the token saved as teamrig-gh-acme';

/** acme/web's issues: 7 and 8 open, 9 open and labelled triaged, 5 closed as not planned; acme/api has none. */
function issues(): FakeGh {
  return new FakeGh()
    .holds('acme/web', [
      ghIssue('acme/web', 7, { title: 'Fix login', assignees: ['octocat'] }),
      ghIssue('acme/web', 8, { title: 'Add search', labels: ['status:open'] }),
      ghIssue('acme/web', 9, { title: 'Faster start', labels: ['bug', 'status:open'] }),
      ghIssue('acme/web', 5, { title: 'Old idea', state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    ])
    .holds('acme/api', []);
}

/** Runs `argv` as the lead and fails the test with its output unless it ends with `code`; gives the lines after ACCESS. */
async function expectRun(kit: CliHarness, argv: readonly string[], gh: FakeGh, code: number): Promise<string[]> {
  const result = await kit.run(argv, { gh, ...AS_LEAD });
  assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
  const [first, ...rest] = result.stdout;
  return first === NO_TOKEN ? rest : [...result.stdout];
}

/** Runs a setup step and fails the test with its output unless it passed. */
async function step(kit: CliHarness, argv: readonly string[], options: { readonly env: Readonly<Record<string, string>> }): Promise<void> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

/** A team task of the lead's holding `ref`. */
async function addHolding(kit: CliHarness, title: string, ref: string): Promise<void> {
  await step(kit, ['add', '--title', title, '--description', 'Work tracked on an issue.', '--priority', 'p2', '--ref', ref], AS_LEAD);
}

describe('teamrig issue sync --push', () => {
  it('plans each held issue against its task status, reading through gh only and writing nothing', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await expectRun(kit, ['issue', 'sync', '--yes'], issues(), EXIT.ok);
    // The import added T1 (#7, bravo), T2 (#8, lead) and T3 (#9, lead); #5 is closed, so it added no task for it.
    await step(kit, ['set', 'T1', '--status', 'in-progress', '--note', 'on it'], AS_BRAVO);
    await step(kit, ['set', 'T2', '--status', 'dropped', '--note', 'not planned'], AS_LEAD);
    await step(kit, ['update', 'T3', '--due', '2030-01-10'], AS_LEAD);
    await addHolding(kit, 'Revive the old idea', 'gh:acme/web#5');
    await addHolding(kit, 'Long gone issue', 'gh:acme/web#3');
    const log = kit.files.get(EVENTS_PATH);
    const gh = issues();
    assert.deepEqual(await expectRun(kit, ['issue', 'sync', '--push'], gh, EXIT.ok), [
      'PUSH acme/web: 3 to change, 0 unchanged, 1 closed on the host while the task is active, 1 not listed',
      'LABEL acme/web#7 T1 in-progress: add status:in progress',
      'CLOSE acme/web#8 T2 dropped: close as not-planned, take off status:open',
      // #9's task is open with a due date, so the issue is claimed and goes to someone: the lead's session maps to no
      // login, so the login the sync runs as, never the repository's owner (T4581).
      'LABEL acme/web#9 T3 open: add status:claimed, take off status:open, assign sync-bot',
      'KEPT acme/web#5 T4 open: closed on the host (not_planned) while the task is active; the push never reopens an issue, so set the task to match or reopen the issue',
      'UNLISTED acme/web#3 T5 open: not open on the host (closed before github.closedDays, or gone) while the task is active; the push never reopens an issue',
      'PUSH acme/api: 0 to change, 0 unchanged',
      `PREVIEW nothing was written; a push would send 6 write(s) now, at most ${PUSH_WRITES_PER_RUN} a run, and plan the rest again on the next`,
    ]);
    const reads = gh.ran.filter((request) => !isIssueQuery(request.args)).map((request) => request.args.join(' '));
    assert.deepEqual(reads, ['api user', 'api users/sync-bot', 'api repos/acme/web/assignees/sync-bot'], 'gh was asked for something other than a shipped issue query or the assignee reads');
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('leaves open an issue taken outside the team, or a design issue, when the task holding it ends (T3350)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await addHolding(kit, 'Answered a question there', 'gh:acme/web#7');
    await addHolding(kit, 'Weighed in on the design', 'gh:acme/web#8');
    await step(kit, ['set', 'T1', '--status', 'dropped', '--note', 'only commented'], AS_LEAD);
    await step(kit, ['set', 'T2', '--status', 'dropped', '--note', 'only commented'], AS_LEAD);
    const gh = new FakeGh()
      .holds('acme/web', [
        ghIssue('acme/web', 7, { title: 'Fix login', assignees: ['eve'], labels: ['status:waiting'] }),
        ghIssue('acme/web', 8, { title: 'How should search work', labels: ['design'] }),
      ])
      .holds('acme/api', []);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/web'], gh, EXIT.ok);
    assert.deepEqual(lines.slice(0, 3), [
      'PUSH acme/web: 0 to change, 0 unchanged, 2 left open: not the finished task\'s to close',
      'OPEN acme/web#7 T1 dropped: taken by eve, outside the team; the push leaves it open, for its taker or a person to close',
      'OPEN acme/web#8 T2 dropped: a design issue, which ends by its maintainers\' Agreed; the push leaves it open, for its taker or a person to close',
    ]);
  });

  it('writes nothing for an issue two team tasks hold, and names them (#1449)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await addHolding(kit, 'Old plan for login', 'gh:acme/web#7');
    await addHolding(kit, 'Land the login fix', 'gh:acme/web#7');
    await step(kit, ['set', 'T2', '--status', 'in-progress', '--note', 'on it'], AS_LEAD);
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { title: 'Fix login', assignees: ['octocat'], labels: ['status:in progress'] })]).holds('acme/api', []);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/web'], gh, EXIT.ok);
    assert.deepEqual(lines, [
      'PUSH acme/web: 0 to change, 0 unchanged, 1 held by two or more tasks',
      'SHARED acme/web#7 T1, T2: two or more team tasks hold it, so the push writes nothing; give the ref to one of them',
      `PREVIEW nothing was written; a push would send 0 write(s) now, at most ${PUSH_WRITES_PER_RUN} a run, and plan the rest again on the next`,
    ]);
  });

  it('reads the pull requests only when an active task holds a number the issue list left out, and names an open one as a pull request (#1451)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await addHolding(kit, 'Land the login fix', 'gh:acme/web#11');
    await addHolding(kit, 'Land the old change', 'gh:acme/web#12');
    const gh = issues().holdsPulls('acme/web', [ghPull('acme/web', 11), ghPull('acme/web', 12, { state: 'MERGED', updatedAt: '2030-01-02T00:00:00Z' })]);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/web'], gh, EXIT.ok);
    assert.deepEqual(lines.slice(0, 1), ['PUSH acme/web: 0 to change, 0 unchanged, 1 on an open pull request, 1 not listed']);
    assert.deepEqual(lines.slice(1, 3), [
      'PULL acme/web#11 T1 open: an open pull request, not an issue; the push writes only issues',
      'UNLISTED acme/web#12 T2 open: not open on the host (closed before github.closedDays, or gone) while the task is active; the push never reopens an issue',
    ]);

    const unread = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/web'], issues().failsPulls('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502: Bad gateway\n' }), EXIT.ok);
    assert.match(unread[0] ?? '', /^NOTE acme\/web: its pull requests could not be read \(.*\), so a number below may be one$/);
    assert.equal(unread[1], 'PUSH acme/web: 0 to change, 0 unchanged, 2 not listed');

    const none = issues();
    await expectRun(new CliHarness(GITHUB_TEAM), ['issue', 'sync', '--push', '--repo', 'acme/web'], none, EXIT.ok);
    assert.ok(
      none.ran.every((request) => isViewerRead(request.args) || (isIssueQuery(request.args) && !request.args.join(' ').includes('pullRequests'))),
      'no task held a number the list left out, so no pull request read',
    );
  });

  it('plans only the repository --repo names', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/api'], issues(), EXIT.ok);
    assert.deepEqual(lines.slice(0, 1), ['PUSH acme/api: 0 to change, 0 unchanged']);
    assert.equal(lines.length, 2);
  });

  it('shows the first changes and counts the rest', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const count = SHOWN_CHANGES + 2;
    const many = Array.from({ length: count }, (_, index) => ghIssue('acme/web', index + 1));
    const gh = new FakeGh().holds('acme/web', many).holds('acme/api', []);
    await expectRun(kit, ['issue', 'sync', '--yes'], gh, EXIT.ok);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--repo', 'acme/web'], gh, EXIT.ok);
    assert.equal(lines[0], `PUSH acme/web: ${count} to change, 0 unchanged`);
    assert.equal(lines[SHOWN_CHANGES + 1], '... and 2 more');
  });

  it("refuses --auto, as the hooks' sync sends the push itself when github.statusPush is on", async () => {
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'sync', '--push', '--auto'], { gh: issues(), ...AS_LEAD });
    assert.equal(result.code, EXIT.refused, result.stdout.join('\n'));
    assert.match([...result.stdout, ...result.stderr].join('\n'), /github\.statusPush/u);
  });

  it('with --yes sends the plan through the shipped label and close calls', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await expectRun(kit, ['issue', 'sync', '--yes'], issues(), EXIT.ok);
    await step(kit, ['set', 'T1', '--status', 'in-progress', '--note', 'on it'], AS_BRAVO);
    await step(kit, ['set', 'T2', '--status', 'dropped', '--note', 'not planned'], AS_LEAD);
    await step(kit, ['update', 'T3', '--due', '2030-01-10'], AS_LEAD);
    const gh = issues().hasLabels('acme/web', ['status:in progress', 'status:claimed']);
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--yes'], gh, EXIT.ok);
    assert.deepEqual(lines.filter((line) => /^(SET|PUSHED) /u.test(line)), [
      'SET acme/web#7 T1 in-progress: add status:in progress',
      'SET acme/web#8 T2 dropped: close as not-planned, take off status:open',
      'SET acme/web#9 T3 open: add status:claimed, take off status:open, assign sync-bot',
      `PUSHED 3 change(s), 6 write(s); at most ${PUSH_WRITES_PER_RUN} a run, the rest planned again on the next`,
    ]);
    assert.deepEqual(
      gh.ran.filter((request) => !isIssueQuery(request.args)).map((request) => request.args.join(' ')),
      [
        'api user',
        'api users/sync-bot',
        'api repos/acme/web/assignees/sync-bot',
        'api repos/acme/web/labels/status%3Ain%20progress',
        'api repos/acme/web/labels/status%3Aclaimed',
        'api repos/acme/web/issues/7/labels -X POST -f labels[]=status:in progress',
        'api repos/acme/web/issues/8/labels/status%3Aopen -X DELETE',
        'api repos/acme/web/issues/8 -X PATCH -f state=closed -f state_reason=not_planned',
        'api repos/acme/web/issues/9/labels -X POST -f labels[]=status:claimed',
        'api repos/acme/web/issues/9/labels/status%3Aopen -X DELETE',
        'api repos/acme/web/issues/9/assignees -X POST -f assignees[]=sync-bot',
      ],
    );
  });

  it('with --yes fails the run on a refused write and refuses a caller not on the team', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await expectRun(kit, ['issue', 'sync', '--yes'], issues(), EXIT.ok);
    await step(kit, ['set', 'T2', '--status', 'dropped', '--note', 'not planned'], AS_LEAD);
    const gh = issues().hasLabels('acme/web', ['status:open', 'status:claimed']).failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' });
    const lines = await expectRun(kit, ['issue', 'sync', '--push', '--yes', '--repo', 'acme/web'], gh, EXIT.failed);
    assert.ok(lines.some((line) => line.startsWith('FAILED acme/web#7 T1: ') && line.endsWith('; the rest of acme/web waits for the next run')), lines.join('\n'));
    const stranger = await kit.run(['issue', 'sync', '--push', '--yes'], { gh, env: { TEAMRIG_SESSION: 'stranger' } });
    assert.equal(stranger.code, EXIT.refused, stranger.stdout.join('\n'));
  });

  it('reads nothing when the machine or the team has GitHub off', async () => {
    const off = new CliHarness(GITHUB_TEAM);
    const gh = issues();
    const result = await off.run(['issue', 'sync', '--push'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.match(result.stdout.join('\n'), /^OFF /);
    const none = await new CliHarness(TEAM).run(['issue', 'sync', '--push'], { gh, ...AS_LEAD });
    assert.match(none.stdout.join('\n'), /^OFF no repository to push to/);
    assert.equal(gh.ran.length, 0);
  });

  it('fails the run for a repository it cannot read, and plans the others', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = issues().answers('acme/api', { stdout: '', stderr: 'HTTP 502: Bad Gateway', end: { kind: 'exited', code: 1 } });
    const lines = await expectRun(kit, ['issue', 'sync', '--push'], gh, EXIT.failed);
    assert.ok(lines.some((line) => line.startsWith('PUSH acme/web: ')));
    assert.ok(lines.some((line) => line.startsWith('FAILED acme/api: ') && line.endsWith('; nothing planned for it')));
  });

  it("after the labels, sets each held issue's fields and type through the shipped calls, and none with github.fields.push off (T3406)", async () => {
    const withFields = (gh: FakeGh): FakeGh =>
      gh.holdsFields('acme/web', {
        fields: [{ __typename: 'IssueFieldSingleSelect', name: 'Priority', fullDatabaseId: '11', options: [{ name: 'P1' }, { name: 'P2' }] }],
        types: [{ name: 'Task', isEnabled: true }],
        issues: [{ number: 7, issueType: null, issueFieldValues: { nodes: [] } }],
      });
    const kit = new CliHarness(GITHUB_TEAM);
    await addHolding(kit, 'Fix login', 'gh:acme/web#7');
    const preview = await expectRun(kit, ['issue', 'sync', '--push'], withFields(issues()), EXIT.ok);
    assert.deepEqual(
      preview.filter((line) => /^(FIELDS|FIELD|TYPE) /u.test(line)),
      ['FIELDS acme/web: 2 to write', 'FIELD acme/web#7 (T1): Priority P2', 'TYPE acme/web#7 (T1): Task'],
    );
    assert.ok(preview.includes('NOTE acme/web: acme/web has no issue field named "Start date", so none is written there'), preview.join('\n'));
    const gh = withFields(issues());
    await expectRun(kit, ['issue', 'sync', '--push', '--yes', '--repo', 'acme/web'], gh, EXIT.ok);
    assert.deepEqual(
      gh.ran.filter((request) => request.args.some((arg) => arg.startsWith('issue_field_values') || arg.startsWith('type='))).map((request) => request.args.join(' ')),
      ['api repos/acme/web/issues/7/issue-field-values -X POST -F issue_field_values[][field_id]=11 -f issue_field_values[][value]=P2', 'api repos/acme/web/issues/7 -X PATCH -f type=Task'],
    );
    const off = new CliHarness({ ...GITHUB_TEAM, github: { repos: ['acme/web'], owners: { octocat: 'bravo' }, fields: { push: false } } });
    await addHolding(off, 'Fix login', 'gh:acme/web#7');
    const quiet = withFields(issues());
    const lines = await expectRun(off, ['issue', 'sync', '--push'], quiet, EXIT.ok);
    assert.ok(!lines.some((line) => line.startsWith('FIELD')), lines.join('\n'));
    assert.ok(!quiet.ran.some((request) => request.args.some((arg) => arg.includes('issueFieldValues'))));
  });

  it('says in its help how many writes a run sends', () => {
    assert.ok(USAGE.includes(`at most ${PUSH_WRITES_PER_RUN} writes a run`));
  });
});
