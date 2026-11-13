import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { adminRolePath } from '../github/admin-store.ts';
import { isIssueClose, isIssueComment, isPullRead } from '../github/gh.ts';
import { CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const LOGIN = 'ACCESS acme: writes with the gh login; no token saved as teamrig-gh-acme';

function printed(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

/** A GitHub team whose admin the owner set to `admin` with `credentials`, so each run must pass the same store. */
async function teamWithAdmin(credentials: FakeCredentials, admin = 'lead'): Promise<CliHarness> {
  const kit = new CliHarness(GITHUB_TEAM);
  const set = await kit.run(['owner', 'github-admin', admin], { credentials });
  assert.equal(set.code, EXIT.ok, printed(set));
  return kit;
}

/** Adds a task of alpha with `ref`, as gh migrate or gh sync leaves an issue's task. */
async function alphaTask(kit: CliHarness, title: string, ref?: string): Promise<void> {
  const refFlag = ref === undefined ? [] : ['--ref', ref];
  const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead', ...refFlag]);
  assert.equal(added.code, EXIT.ok, printed(added));
}

describe('teamrig issue comment', () => {
  it('posts one comment through the allowlisted call and writes nothing to the task list', async () => {
    const credentials = new FakeCredentials();
    const kit = await teamWithAdmin(credentials);
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'comment', 'Acme/Web#612', '--body', 'Thank you! Merged as #624.'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, [LOGIN, 'COMMENTED acme/web#612']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/612/comments', '-X', 'POST', '-f', 'body=Thank you! Merged as #624.']]);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('refuses, running no gh, a caller not on the team, a repository not listed, a bad target, and a body that is empty, secret or names a task id', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    /** Built at runtime so no secret-shaped literal sits in the source. */
    const secret = ['ghp', '_', 'a'.repeat(36)].join('');
    const cases: Array<[readonly string[], Readonly<Record<string, string>>, RegExp]> = [
      [['issue', 'comment', 'acme/web#7', '--body', 'x'], { TEAMRIG_SESSION: 'stranger' }, /^REFUSED stranger is not a session on this team/u],
      [['issue', 'comment', 'acme/api#7', '--body', 'x'], AS_LEAD.env, /^REFUSED acme\/api is not one of the team's repositories: list it under github\.repos in the team config \(now acme\/web\)/u],
      [['issue', 'comment', 'acme/web/issues/7', '--body', 'x'], AS_LEAD.env, /^REFUSED acme\/web\/issues\/7 names no issue or pull request: give it as owner\/name#number/u],
      [['issue', 'comment', 'acme/web#7', '--body', ' '], AS_LEAD.env, /^REFUSED --body is empty/u],
      [['issue', 'comment', 'acme/web#7', '--body', `key ${secret}`], AS_LEAD.env, /^REFUSED --body looks like it holds a secret/u],
      [['issue', 'comment', 'acme/web#7', '--body', 'Done in T12'], AS_LEAD.env, /^REFUSED --body names the task id T12/u],
    ];
    for (const [argv, env, error] of cases) {
      const result = await kit.run(argv, { env, gh });
      assert.equal(result.code, EXIT.refused, `${argv.join(' ')}\n${printed(result)}`);
      assert.match(printed(result), error, argv.join(' '));
      assert.ok(!printed(result).includes(secret));
    }
    const missing = await kit.run(['issue', 'comment', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.match(printed(missing), /--body is required/u);
    assert.deepEqual(gh.ran, []);
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'comment', 'acme/web#7', '--body', 'x'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});

describe('teamrig issue close', () => {
  it("comments, then closes, with the owner's token, never printing it", async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token');
    const kit = await teamWithAdmin(credentials);
    const result = await kit.run(['issue', 'close', 'acme/web#612', '--comment', 'Closing in favour of #624.'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, ['ACCESS acme: writes with the token saved as teamrig-gh-acme', 'COMMENTED acme/web#612', 'CLOSED acme/web#612']);
    assert.equal(gh.ran.length, 2);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
    assert.ok(!printed(result).includes('acme-issues-token'));
  });

  it('closes with no comment when none is given', async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials();
    const result = await (await teamWithAdmin(credentials)).run(['issue', 'close', 'acme/web#7'], { ...AS_LEAD, gh, credentials });
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed']]);
  });

  it('stops, running no gh, when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials();
    const kit = await teamWithAdmin(credentials);
    credentials.failsOn('teamrig-gh-acme', 'the keyring is locked');
    const result = await kit.run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout, [
      'FAILED acme/web#7: could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme; nothing was written',
    ]);
    assert.deepEqual(gh.ran, []);
  });

  it('fails, closing nothing, when GitHub refuses the comment', async () => {
    const gh = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    const credentials = new FakeCredentials();
    const result = await (await teamWithAdmin(credentials)).run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), [
      'FAILED acme/web#7: the gh login may not comment on acme/web#7: save a token for acme with Issues and Pull requests read and write, with: save teamrig-gh-acme; it was not closed',
    ]);
    assert.equal(gh.ran.length, 1);
  });
});

describe('teamrig issue writes: only the GitHub admin writes on what is not the caller own (T2705)', () => {
  it('lets a session close the issue its own task has as its ref, with no admin set', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await alphaTask(kit, 'Fix the login page', 'gh:acme/web#7');
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'close', 'acme/web#7'], { ...AS_ALPHA, gh });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7']);
    assert.equal(gh.ran.length, 1);
  });

  it('lets a session comment on a pull request from a t<id>- branch of its own task', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await alphaTask(kit, 'Fix the login page');
    const gh = new FakeGh().opensPull('acme/web', 9, 't1-login-page');
    const result = await kit.run(['issue', 'comment', 'acme/web#9', '--body', 'Rebased on main.'], { ...AS_ALPHA, gh });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.ok(isPullRead(gh.ran[0]?.args ?? []) && isIssueComment(gh.ran[1]?.args ?? []));
  });

  it("refuses a session that is not the admin on another's issue, a fork's branch named like its own, and writes nothing", async () => {
    const credentials = new FakeCredentials();
    const kit = await teamWithAdmin(credentials);
    await alphaTask(kit, 'Fix the login page');
    const gh = new FakeGh().opensPull('acme/web', 9, 't1-login-page', 'stranger/web');
    const issue = await kit.run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_ALPHA, gh, credentials });
    assert.equal(issue.code, EXIT.refused);
    assert.equal(
      printed(issue),
      'REFUSED alpha may write only on its own issues and pull requests, and acme/web#7 is not one: no task of alpha has it as its ref, and it is no pull request; the GitHub admin, lead, writes on the rest',
    );
    const fork = await kit.run(['issue', 'close', 'acme/web#9'], { ...AS_ALPHA, gh, credentials });
    assert.match(printed(fork), /its pull request's branch t1-login-page is in stranger\/web, not acme\/web;/u);
    assert.ok(gh.ran.every((request) => isPullRead(request.args)));
  });

  it('names a role a session edited as broken, so no session is admin', async () => {
    const credentials = new FakeCredentials();
    const kit = await teamWithAdmin(credentials);
    const file = adminRolePath(TEAM_HOME);
    await kit.files.write(file, (kit.files.get(file) ?? '').replace('"lead"', '"alpha"'));
    const gh = new FakeGh();
    for (const env of [AS_ALPHA, AS_LEAD]) {
      const result = await kit.run(['issue', 'close', 'acme/web#7'], { ...env, gh, credentials });
      assert.equal(result.code, EXIT.refused, printed(result));
      assert.match(printed(result), /the GitHub admin writes on the rest, and the role reads broken \(the GitHub admin role file does not match its signature/u);
    }
    assert.ok(gh.ran.every((request) => isPullRead(request.args)));
  });

  it("refuses a --session other than the tab's own, so no session borrows the admin's right", async () => {
    const credentials = new FakeCredentials();
    const kit = await teamWithAdmin(credentials);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'close', 'acme/web#7', '--session', 'lead'], { ...AS_ALPHA, gh, credentials });
    assert.equal(result.code, EXIT.refused);
    assert.equal(printed(result), "REFUSED --session lead is not this tab's session (alpha): teamrig issue writes only as the tab's own session");
    assert.deepEqual(gh.ran, []);
  });

  it('fails, writing nothing, when GitHub cannot say whose the pull request is', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 4 }, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n' });
    const result = await kit.run(['issue', 'close', 'acme/web#9'], { ...AS_ALPHA, gh });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout.join('\n'), /^FAILED could not tell whose acme\/web#9 is: gh is not logged in to GitHub.*; nothing was written$/u);
    assert.equal(gh.ran.length, 1);
  });
});
