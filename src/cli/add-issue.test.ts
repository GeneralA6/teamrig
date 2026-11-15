import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { foldEvents, type Task } from '../register/fold.ts';
import { readEvents } from '../register/snapshot.ts';
import { CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const AT_ADD_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'], issueAtAdd: 'acme/web' } };
const OPEN_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const TASK = ['add', '--title', 'Private health check', '--description', 'private what and why', '--priority', 'p2'];
const ISSUE = ['--issue', 'Add a health check', '--issue-body', 'A probe the load balancer reads.'];

function tasksOf(kit: CliHarness): ReadonlyMap<string, Task> {
  return foldEvents(readEvents(kit.files.get(EVENTS_PATH) ?? '').events).tasks;
}

function withToken(): FakeCredentials {
  return new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token');
}

describe('teamrig add with its issue', () => {
  it('opens the issue with the public wording only and points the new task at it', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const gh = new FakeGh().holds('acme/web', []);
    const result = await kit.run([...TASK, '--type', 'bug', ...ISSUE], { ...AS_LEAD, gh, credentials: withToken() });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(result.stdout.at(-1), 'OPENED T1 gh:acme/web#1');
    assert.deepEqual(
      gh.ran.map((request) => request.args),
      [['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=Add a health check', '-f', 'body=A probe the load balancer reads.', '-f', 'labels[]=bug', '-f', 'labels[]=p2']],
    );
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token']);
    const task = tasksOf(kit).get('T1');
    assert.deepEqual([task?.title, task?.ref], ['Private health check', 'gh:acme/web#1']);
  });

  it('opens in --issue-repo when it names another of github.repos', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const gh = new FakeGh().holds('acme/api', []);
    const result = await kit.run([...TASK, ...ISSUE, '--issue-repo', 'Acme/API'], { ...AS_LEAD, gh, credentials: withToken() });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(tasksOf(kit).get('T1')?.ref, 'gh:acme/api#1');
  });

  it('keeps a task local with its reason as its ref, opening nothing', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const gh = new FakeGh();
    const result = await kit.run([...TASK, '--local', 'names an unfixed weakness'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(gh.ran, []);
    assert.equal(tasksOf(kit).get('T1')?.ref, 'local: names an unfixed weakness');
  });

  it('refuses an add with neither, while github.issueAtAdd is set, and writes no task', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const result = await kit.run(TASK, { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(result.code, EXIT.refused);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /github\.issueAtAdd is acme\/web: give the task's public issue with --issue/u);
    assert.equal(tasksOf(kit).size, 0);
  });

  it('refuses wording naming a task id before writing anything', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const gh = new FakeGh();
    const result = await kit.run([...TASK, '--issue', 'Follow up on T12', '--issue-body', 'More.'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.refused);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /the new task: the title or body names the task id T12/u);
    assert.deepEqual(gh.ran, []);
    assert.equal(tasksOf(kit).size, 0);
  });

  it('adds as before with issueAtAdd empty and no issue flag', async () => {
    const kit = new CliHarness(OPEN_TEAM);
    const gh = new FakeGh();
    const result = await kit.run(TASK, { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(gh.ran, []);
    assert.equal(tasksOf(kit).get('T1')?.ref, null);
  });

  it('keeps the task and says how to give it its issue when GitHub fails', async () => {
    const kit = new CliHarness(OPEN_TEAM);
    const gh = new FakeGh();
    const credentials = new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked');
    const result = await kit.run([...TASK, ...ISSUE, '--issue-repo', 'acme/web'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout.at(-1) ?? '', /^FAILED T1's issue: .*the keyring is locked.*; T1 is written with no issue; open it with teamrig issue migrate, or point its ref at one with teamrig update T1 --ref$/u);
    assert.deepEqual(gh.ran, []);
    assert.equal(tasksOf(kit).get('T1')?.ref, null);
  });

  it('opens nothing with GitHub off on the machine, and keeps the task', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const gh = new FakeGh();
    const result = await kit.run([...TASK, ...ISSUE], { env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' }, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.match(result.stdout.at(-1) ?? '', /^OFF TEAMRIG_GITHUB=off turns GitHub off on this machine; T1 is written with no issue/u);
    assert.deepEqual(gh.ran, []);
    assert.equal(tasksOf(kit).size, 1);
  });

  it('refuses the issue flags on an add to another team', async () => {
    const kit = new CliHarness(AT_ADD_TEAM);
    const result = await kit.run([...TASK, '--team', 'other', '--local', 'why'], AS_LEAD);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--local works on an add to your own team: on team other the task's owner gives it its issue/u);
  });
});
