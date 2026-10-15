import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { isReadCommand } from '../github/gh.ts';
import { foldEvents, type Task } from '../register/fold.ts';
import { readEvents } from '../register/snapshot.ts';
import { CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'], owners: { octocat: 'bravo' } } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const AS_BRAVO = { env: { TEAMRIG_SESSION: 'bravo' } };

/** A gh holding two open issues of acme/web and none of acme/api. */
function twoIssues(): FakeGh {
  return new FakeGh()
    .holds('acme/web', [ghIssue('acme/web', 7, { title: 'Fix login', labels: ['p1'], assignees: ['octocat'] }), ghIssue('acme/web', 8, { title: 'Add search' })])
    .holds('acme/api', []);
}

/** Every task in the log, and who wrote each event. */
function register(kit: CliHarness): { tasks: ReadonlyMap<string, Task>; writers: string[] } {
  const events = readEvents(kit.files.get(EVENTS_PATH) ?? '').events;
  return { tasks: foldEvents(events).tasks, writers: events.map((event) => event.by) };
}

/** Runs `argv` and fails the test with its output unless it ends with `code`. */
async function expectRun(kit: CliHarness, argv: readonly string[], gh: FakeGh, code: number, env: Readonly<Record<string, string>> = {}): Promise<string[]> {
  const result = await kit.run(argv, { gh, env });
  assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
  assert.ok(gh.ran.every((request) => isReadCommand(request.args)), 'gh was asked for something other than a read');
  return [...result.stdout];
}

/** Built at runtime so no credential-shaped literal sits in the source. */
function credentialUrl(): string {
  return ['https://', 'user', ':', 'hunter2', '@', 'example.test'].join('');
}

describe('teamrig gh sync', () => {
  it('previews the import, reading through gh only and writing nothing', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = twoIssues();
    assert.deepEqual(await expectRun(kit, ['gh', 'sync'], gh, EXIT.ok), [
      'REPO acme/web: 2 to add, 0 to change, 0 unchanged',
      'ADD new gh:acme/web#7 p1 bravo: "Fix login"',
      'ADD new gh:acme/web#8 p2 lead: "Add search"',
      'REPO acme/api: 0 to add, 0 to change, 0 unchanged',
      'PREVIEW nothing was written; teamrig gh sync --yes writes the above as github',
    ]);
    assert.equal(kit.files.get(EVENTS_PATH), undefined);
    assert.equal(gh.ran.length, 4);
  });

  it('writes the tasks as github with --yes, and a second run writes nothing', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = twoIssues();
    assert.deepEqual(await expectRun(kit, ['gh', 'sync', '--yes'], gh, EXIT.ok), [
      'REPO acme/web: 2 added, 0 changed, 0 unchanged',
      'ADD T1 gh:acme/web#7 p1 bravo: "Fix login"',
      'ADD T2 gh:acme/web#8 p2 lead: "Add search"',
      'REPO acme/api: 0 added, 0 changed, 0 unchanged',
      'WROTE 2 change(s) to the task list as github; GitHub was only read',
    ]);
    const { tasks, writers } = register(kit);
    const task = tasks.get('T1');
    assert.deepEqual([task?.source, task?.ref, task?.owner, task?.priority, task?.status], ['github', 'gh:acme/web#7', 'bravo', 1, 'open']);
    assert.deepEqual(writers, ['github', 'github']);
    const log = kit.files.get(EVENTS_PATH);
    assert.deepEqual((await expectRun(kit, ['gh', 'sync', '--yes'], gh, EXIT.ok)).slice(0, 1), ['REPO acme/web: 0 added, 0 changed, 2 unchanged']);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it("keeps the team's work on a task, and follows GitHub's title, priority and open or closed state", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await expectRun(kit, ['gh', 'sync', '--yes'], twoIssues(), EXIT.ok);
    for (const [argv, options] of [
      [['set', 'T1', '--status', 'in-progress', '--note', 'on it'], AS_BRAVO],
      [['update', 'T2', '--owner', 'alpha', '--priority', 'p3'], AS_LEAD],
    ] as const) {
      const result = await kit.run(argv, options);
      assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    }
    const changed = new FakeGh()
      .holds('acme/web', [
        ghIssue('acme/web', 7, { title: 'Fix the login', labels: ['p1'], state: 'CLOSED', stateReason: 'COMPLETED' }),
        ghIssue('acme/web', 8, { title: 'Add search' }),
      ])
      .holds('acme/api', []);
    assert.deepEqual((await expectRun(kit, ['gh', 'sync', '--yes'], changed, EXIT.ok)).slice(0, 4), [
      'REPO acme/web: 0 added, 2 changed, 0 unchanged',
      'UPDATE T2 gh:acme/web#8: priority p2',
      'UPDATE T1 gh:acme/web#7: title "Fix the login"',
      'SET T1 gh:acme/web#7 done: closed on GitHub as completed',
    ]);
    const { tasks } = register(kit);
    const [first, second] = [tasks.get('T1'), tasks.get('T2')];
    assert.deepEqual([first?.status, first?.evidence, first?.owner, first?.updatedBy], ['done', 'https://github.com/acme/web/issues/7', 'bravo', 'github']);
    assert.deepEqual([second?.owner, second?.priority, second?.status], ['alpha', 2, 'open']);
    const reopened = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { title: 'Fix the login', labels: ['p1'] }), ghIssue('acme/web', 8, { title: 'Add search' })]).holds('acme/api', []);
    assert.deepEqual((await expectRun(kit, ['gh', 'sync', '--yes', '--repo', 'ACME/web'], reopened, EXIT.ok)).slice(0, 2), [
      'REPO acme/web: 0 added, 1 changed, 1 unchanged',
      'SET T1 gh:acme/web#7 open: open on GitHub',
    ]);
    assert.equal(reopened.ran.length, 2);
  });

  it('leaves a task the team added alone, even one that cites the issue', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const added = await kit.run(['add', '--title', 'Fix login', '--priority', 'p1', '--ref', 'gh:acme/web#7'], AS_BRAVO);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    await expectRun(kit, ['gh', 'sync', '--yes'], twoIssues(), EXIT.ok);
    const { tasks } = register(kit);
    assert.deepEqual([tasks.get('T1')?.source, tasks.get('T1')?.status, tasks.get('T2')?.source, tasks.get('T2')?.ref], ['bravo', 'open', 'github', 'gh:acme/web#7']);
  });

  it('reads nothing when the machine or the team has it off', async () => {
    const gh = twoIssues();
    assert.deepEqual(await expectRun(new CliHarness(GITHUB_TEAM), ['gh', 'sync', '--yes'], gh, EXIT.ok, { TEAMRIG_GITHUB: ' OFF ' }), [
      'OFF TEAMRIG_GITHUB=off turns the GitHub import off on this machine; nothing was read or written',
    ]);
    assert.deepEqual(await expectRun(new CliHarness(), ['gh', 'sync', '--repo', 'acme/web'], gh, EXIT.ok), [
      'OFF no repository to read: list them as "owner/name" under github.repos in the team config; nothing was read or written',
    ]);
    assert.equal(gh.ran.length, 0);
  });

  it('refuses a repository the team does not list, and a word it does not take', async () => {
    const gh = twoIssues();
    const kit = new CliHarness(GITHUB_TEAM);
    assert.deepEqual(await expectRun(kit, ['gh', 'sync', '--repo', 'acme/other'], gh, EXIT.refused), ['REFUSED --repo acme/other is not one of github.repos (acme/web, acme/api)']);
    await expectRun(kit, ['gh', 'sync', 'acme/web'], gh, EXIT.usage);
    assert.equal(gh.ran.length, 0);
  });

  it('syncs the repositories it can read, and fails the run for one it cannot', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]);
    const lines = await expectRun(kit, ['gh', 'sync', '--yes'], gh, EXIT.failed);
    assert.deepEqual(lines.slice(2), [
      'FAILED acme/api: acme/api is not visible to the gh login: check github.repos, and that gh auth status shows an account that can read it; its tasks stay as they are',
      'WROTE 1 change(s) to the task list as github; GitHub was only read',
    ]);
  });

  it('reports a step the register refuses, writes the rest and shows the first ten rows', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const many = Array.from({ length: 12 }, (_, index) => ghIssue('acme/web', index + 1));
    const gh = new FakeGh().holds('acme/web', [...many, ghIssue('acme/web', 13, { title: `Leaked ${credentialUrl()}` })]).holds('acme/api', []);
    const lines = await expectRun(kit, ['gh', 'sync', '--yes'], gh, EXIT.refused);
    assert.equal(lines[0], 'REPO acme/web: 12 added, 0 changed, 0 unchanged, 1 refused');
    assert.deepEqual(lines.slice(10, 14), [
      'ADD T10 gh:acme/web#10 p2 lead: "Issue 10"',
      '... and 2 more',
      'SKIPPED gh:acme/web#13: title looks like it holds a secret (credentials in a URL); refer to where it is kept instead',
      'REPO acme/api: 0 added, 0 changed, 0 unchanged',
    ]);
    assert.equal(register(kit).tasks.size, 12);
  });

  it('previews a change of each kind before it is written', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await expectRun(kit, ['gh', 'sync', '--yes'], twoIssues(), EXIT.ok);
    const closed = new FakeGh()
      .holds('acme/web', [ghIssue('acme/web', 7, { title: 'Fix login', labels: ['p3'], state: 'CLOSED', stateReason: 'NOT_PLANNED' }), ghIssue('acme/web', 8, { title: 'Add search' })])
      .holds('acme/api', []);
    const log = kit.files.get(EVENTS_PATH);
    assert.deepEqual((await expectRun(kit, ['gh', 'sync'], closed, EXIT.ok)).slice(0, 3), [
      'REPO acme/web: 0 to add, 1 to change, 1 unchanged',
      'UPDATE T1 gh:acme/web#7: priority p3',
      'SET T1 gh:acme/web#7 dropped: closed on GitHub as not planned',
    ]);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });
});
