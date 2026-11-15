import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { isIssueClose, isIssueComment } from '../github/gh.ts';
import { CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const LOGIN = 'ACCESS acme: writes with the gh login; no token saved as teamrig-gh-acme';

describe('teamrig issue comment', () => {
  it('posts one comment through the allowlisted call and writes nothing to the task list', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'comment', 'Acme/Web#612', '--body', 'Thank you! Merged as #624.'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
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
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, `${argv.join(' ')}\n${printed}`);
      assert.match(printed, error, argv.join(' '));
      assert.ok(!printed.includes(secret));
    }
    const missing = await kit.run(['issue', 'comment', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.match([...missing.stdout, ...missing.stderr].join('\n'), /--body is required/u);
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
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#612', '--comment', 'Closing in favour of #624.'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, ['ACCESS acme: writes with the token saved as teamrig-gh-acme', 'COMMENTED acme/web#612', 'CLOSED acme/web#612']);
    assert.equal(gh.ran.length, 2);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
    assert.ok(![...result.stdout, ...result.stderr].some((line) => line.includes('acme-issues-token')));
  });

  it('closes with no comment when none is given', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed']]);
  });

  it('stops, running no gh, when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked');
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout, [
      'FAILED acme/web#7: could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme; nothing was written',
    ]);
    assert.deepEqual(gh.ran, []);
  });

  it('fails, closing nothing, when GitHub refuses the comment', async () => {
    const gh = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), [
      'FAILED acme/web#7: the gh login may not comment on acme/web#7: save a token for acme with Issues and Pull requests read and write, with: save teamrig-gh-acme; it was not closed',
    ]);
    assert.equal(gh.ran.length, 1);
  });
});
