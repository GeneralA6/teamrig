import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { isIssueCreate, isIssueQuery } from '../github/gh.ts';
import { foldEvents, type Task } from '../register/fold.ts';
import { readEvents } from '../register/snapshot.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const ROWS = join(APP, 'rows.jsonl');
const PREVIEW = join(APP, 'preview.md');
const NO_TOKEN = 'ACCESS acme: opens issues with the gh login; no token saved as teamrig-gh-acme';

function issueRow(id: string, repo: string, title: string, overrides: JsonRecord = {}): string {
  return JSON.stringify({ id, decision: 'issue', repo, type: 'task', priority: 'p2', title, body: `Why ${title}.`, ...overrides });
}

/** A team with three open tasks, T1 to T3, and rows opening T1 in acme/web, T2 in acme/api as a p1 bug, keeping T3 local. */
async function migratingTeam(): Promise<CliHarness> {
  const kit = new CliHarness(GITHUB_TEAM);
  for (const title of ['Private health check', 'Private login bug', 'Private host move']) {
    const added = await kit.run(['add', '--title', title, '--description', 'private what and why', '--priority', 'p2', '--owner', 'alpha'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
  }
  await kit.files.write(
    ROWS,
    [issueRow('T1', 'acme/web', 'Add a health check'), issueRow('T2', 'Acme/API', 'Login fails on retry', { type: 'bug', priority: 'p1' }), JSON.stringify({ id: 'T3', decision: 'local', reason: 'Names a host.' }), ''].join('\n'),
  );
  return kit;
}

function tasksOf(kit: CliHarness): ReadonlyMap<string, Task> {
  return foldEvents(readEvents(kit.files.get(EVENTS_PATH) ?? '').events).tasks;
}

async function expectRun(kit: CliHarness, argv: readonly string[], gh: FakeGh, code: number, options: { readonly credentials?: FakeCredentials } = {}): Promise<string[]> {
  const result = await kit.run(argv, { ...AS_LEAD, gh, ...options });
  assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
  return [...result.stdout];
}

describe('teamrig gh migrate', () => {
  it('previews the move and writes nothing but the preview file', async () => {
    const kit = await migratingTeam();
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    assert.deepEqual(await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--out', 'preview.md'], gh, EXIT.ok), [
      `PREVIEW FILE ${PREVIEW}`,
      '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row',
      "PREVIEW nothing was written; teamrig gh migrate <file> --yes opens the issues and sets each task's ref",
    ]);
    assert.deepEqual(gh.ran, []);
    assert.equal(kit.files.get(EVENTS_PATH), log);
    const preview = kit.files.get(PREVIEW) ?? '';
    assert.match(preview, /### T1 → acme\/web \[enhancement, p2\]\n\n\*\*Add a health check\*\*\n\nWhy Add a health check\./u);
    assert.match(preview, /### T2 → acme\/api \[bug, p1\]/u);
    assert.match(preview, /- T3: Names a host\./u);
    assert.doesNotMatch(preview, /Private/u);
  });

  it('names the live tasks no row covers and the rows it skips', async () => {
    const kit = await migratingTeam();
    await kit.files.write(ROWS, [issueRow('T1', 'acme/other', 'Add a health check'), issueRow('T9', 'acme/web', 'Gone')].join('\n'));
    assert.deepEqual(await expectRun(kit, ['gh', 'migrate', ROWS], new FakeGh(), EXIT.ok), [
      'SKIPPED T1: acme/other is not one of github.repos (acme/web, acme/api)',
      'SKIPPED T9: no such task in the working set',
      'NO ROW 2 live task(s) no row names: T2 T3',
      '0 issue(s) to open, 0 kept local, 2 skipped, 2 live task(s) with no row',
      "PREVIEW nothing was written; teamrig gh migrate <file> --yes opens the issues and sets each task's ref",
    ]);
  });

  it('opens each issue, points its task at it, and a rerun and a sync add nothing', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []);
    assert.deepEqual(await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok), [
      '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row',
      NO_TOKEN,
      'OPENED T1 gh:acme/web#1',
      'OPENED T2 gh:acme/api#1',
      "DONE opened 2 issue(s) and set each task's ref",
    ]);
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [
        ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=Add a health check', '-f', 'body=Why Add a health check.', '-f', 'labels[]=enhancement', '-f', 'labels[]=p2'],
        ['api', 'repos/acme/api/issues', '-X', 'POST', '-f', 'title=Login fails on retry', '-f', 'body=Why Login fails on retry.', '-f', 'labels[]=bug', '-f', 'labels[]=p1'],
      ],
    );
    const tasks = tasksOf(kit);
    assert.deepEqual([...tasks.values()].map((task) => [task.id, task.ref, task.title, task.status]), [
      ['T1', 'gh:acme/web#1', 'Private health check', 'open'],
      ['T2', 'gh:acme/api#1', 'Private login bug', 'open'],
      ['T3', null, 'Private host move', 'open'],
    ]);

    const rerun = new FakeGh();
    assert.deepEqual(await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], rerun, EXIT.ok), [
      'SKIPPED T1: the task has its issue already: gh:acme/web#1',
      'SKIPPED T2: the task has its issue already: gh:acme/api#1',
      '0 issue(s) to open, 1 kept local, 2 skipped, 0 live task(s) with no row',
      "DONE opened 0 issue(s) and set each task's ref",
    ]);
    assert.deepEqual(rerun.ran, []);

    const synced = await kit.run(['gh', 'sync', '--yes'], { ...AS_LEAD, gh });
    assert.equal(synced.code, EXIT.ok, synced.stdout.join('\n'));
    assert.ok(gh.ran.slice(2).every((request) => isIssueQuery(request.args)));
    assert.equal(tasksOf(kit).size, 3, synced.stdout.join('\n'));
  });

  it("replaces a task's note ref with its issue, naming the old ref in the preview and the task's history", async () => {
    const kit = await migratingTeam();
    const noted = await kit.run(['update', 'T1', '--ref', 'notes/plan.md'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(noted.code, EXIT.ok, noted.stdout.join('\n'));
    const replaces = 'REPLACES T1: its ref notes/plan.md gives way to its issue';
    assert.equal((await expectRun(kit, ['gh', 'migrate', 'rows.jsonl'], new FakeGh(), EXIT.ok))[0], replaces);
    const lines = await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], new FakeGh(), EXIT.ok);
    assert.deepEqual(lines.slice(0, 2), [replaces, '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row']);
    assert.equal(tasksOf(kit).get('T1')?.ref, 'gh:acme/web#1');
    assert.ok((kit.files.get(EVENTS_PATH) ?? '').includes('ref was: notes/plan.md'));
  });

  it('opens with the token saved for the owner', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const credentials = new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token');
    const lines = await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok, { credentials });
    assert.equal(lines[1], 'ACCESS acme: opens issues with the token saved as teamrig-gh-acme');
    assert.deepEqual(
      gh.ran.map((request) => request.env['GH_TOKEN']),
      ['acme-issues-token', 'acme-issues-token'],
    );
    assert.ok(!lines.join('\n').includes('acme-issues-token'));
  });

  it('stops at the first issue gh fails to open, and a rerun opens the rest', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    assert.deepEqual((await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.failed)).slice(2), [
      'FAILED T1: gh api for an issue of acme/web exited with code 1: gh: Resource not accessible by integration (HTTP 403)',
      'STOPPED at T1 after opening 0 issue(s); fix the cause and rerun: tasks holding their issue are skipped',
    ]);
    assert.equal(gh.ran.length, 1);
    assert.ok([...tasksOf(kit).values()].every((task) => task.ref === null));

    const fixed = new FakeGh();
    assert.deepEqual((await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], fixed, EXIT.ok)).slice(2), ['OPENED T1 gh:acme/web#1', 'OPENED T2 gh:acme/api#1', "DONE opened 2 issue(s) and set each task's ref"]);
  });

  it('says to look on GitHub when gh printed no issue number', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 0 }, stdout: 'created', stderr: '' });
    const lines = await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.failed);
    assert.equal(lines[2], "FAILED T1: gh printed no issue number: look for it on acme/web before a rerun, and set the task's ref if it is there");
  });

  it('runs gh for issue creates only', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    await expectRun(kit, ['gh', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok);
    assert.ok(gh.ran.length > 0 && gh.ran.every((request) => isIssueCreate(request.args)));
  });

  it('opens nothing while GitHub is off on the machine', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const result = await kit.run(['gh', 'migrate', 'rows.jsonl', '--yes'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });

  it('refuses a bad row file, naming the line, and a missing one', async () => {
    const kit = await migratingTeam();
    await kit.files.write(ROWS, `\n${issueRow('T1', 'acme/web', 'x', { status: 'open' })}`);
    const bad = await kit.run(['gh', 'migrate', 'rows.jsonl'], { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(bad.code, EXIT.refused);
    assert.match(bad.stdout.join('\n'), /^REFUSED .*rows\.jsonl: line 2: T1: unknown key status$/u);
    const missing = await kit.run(['gh', 'migrate', 'none.jsonl'], { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(missing.code, EXIT.refused);
    assert.match(missing.stdout.join('\n'), /^REFUSED no row file .*none\.jsonl$/u);
  });
});
