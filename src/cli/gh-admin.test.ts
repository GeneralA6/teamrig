import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../core/home.ts';
import { adminRolePath } from '../github/admin-store.ts';
import { CliHarness, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { LEAD_TEAM, ok } from '../testing/hired-team.ts';
import { EXIT } from './runtime.ts';

const ROLE_FILE = adminRolePath(TEAM_HOME);
const KEY_NAME = 'teamrig-github-admin-app';
const UNDER_CLAUDE_CODE: Env = { CLAUDECODE: '1' };

/** A team of lead and alpha whose store is `credentials`, so a test can see what was saved and make a save fail. */
interface AdminTeam {
  readonly kit: CliHarness;
  readonly credentials: FakeCredentials;
  run(args: readonly string[], env?: Env): Promise<CliResult>;
}

function teamWith(credentials = new FakeCredentials()): AdminTeam {
  const kit = new CliHarness(LEAD_TEAM);
  return { kit, credentials, run: (args, env) => kit.run([...args], env === undefined ? { credentials } : { credentials, env }) };
}

function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stdout.join('\n'), reason);
}

describe('teamrig owner github-admin (T2705)', () => {
  it('names the admin, saves its key, and gh admin reads it back', async () => {
    const { kit, credentials, run } = teamWith();
    const set = ok(await run(['owner', 'github-admin', 'alpha']));
    assert.deepEqual(set.stdout, [
      'SET alpha is the GitHub admin of team app: it may close, comment on and delete any issue, pull request or branch of the repositories github.repos will list; every other session only its own',
    ]);
    assert.deepEqual(credentials.saved, [KEY_NAME]);
    assert.ok(kit.files.get(ROLE_FILE)?.includes('"session": "alpha"'));
    assert.deepEqual(ok(await run(['gh', 'admin'])).stdout, ['ADMIN alpha is the GitHub admin of team app, set 2030-01-08T10:00:00.000Z']);
  });

  it('names the repositories the admin acts on when github.repos lists them', async () => {
    const credentials = new FakeCredentials();
    const kit = new CliHarness({ ...LEAD_TEAM, github: { repos: ['acme/web', 'acme/api'] } });
    const set = ok(await kit.run(['owner', 'github-admin', 'alpha'], { credentials }));
    assert.match(set.stdout.join(''), / of acme\/web, acme\/api; /);
  });

  it('reads a role file a session edited to name itself as broken: no session is admin', async () => {
    const { kit, run } = teamWith();
    ok(await run(['owner', 'github-admin', 'alpha']));
    const file = kit.files.get(ROLE_FILE) ?? '';
    await kit.files.write(ROLE_FILE, file.replace('"alpha"', '"lead"'));
    assert.deepEqual(ok(await run(['gh', 'admin'])).stdout, [
      'BROKEN the GitHub admin role file does not match its signature: it was changed after the owner set it; no session is admin until the owner runs teamrig owner github-admin <session> again',
    ]);
  });

  it('removes the role with none, and says when there was none', async () => {
    const { run } = teamWith();
    ok(await run(['owner', 'github-admin', 'alpha']));
    assert.deepEqual(ok(await run(['owner', 'github-admin', 'none'])).stdout, ['CLEARED team app has no GitHub admin now']);
    assert.deepEqual(ok(await run(['owner', 'github-admin', 'none'])).stdout, ['NONE team app had no GitHub admin; nothing changed']);
    assert.deepEqual(ok(await run(['gh', 'admin'])).stdout, [
      'NONE team app has no GitHub admin: each session acts only on its own issues, pull requests and branches',
    ]);
  });

  it('fails, leaving the role as it was, when the key cannot be saved', async () => {
    const { kit, run } = teamWith(new FakeCredentials().failsSaving('no keyring is running'));
    const result = await run(['owner', 'github-admin', 'alpha']);
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout, ['FAILED the GitHub admin key was not saved: no keyring is running; the role is as it was']);
    assert.equal(kit.files.get(ROLE_FILE), undefined);
  });

  it('refuses a session not on the team, writing nothing', async () => {
    const { kit, credentials, run } = teamWith();
    assertRefused(await run(['owner', 'github-admin', 'stranger']), /stranger/);
    assert.deepEqual(credentials.saved, []);
    assert.equal(kit.files.get(ROLE_FILE), undefined);
  });

  it('refuses under CLAUDECODE, so no agent names an admin, itself or another', async () => {
    const { credentials, run } = teamWith();
    assertRefused(
      await run(['owner', 'github-admin', 'alpha'], UNDER_CLAUDE_CODE),
      /^REFUSED teamrig owner github-admin acts as the owner, so it is refused where Claude Code runs it \(CLAUDECODE is set: an agent's tool call, a script it runs or a hook\); the owner runs it in their own terminal or types \/teamrig owner github-admin in a tab$/,
    );
    assertRefused(await run(['owner', 'github-admin', 'none'], UNDER_CLAUDE_CODE), /acts as the owner/);
    assert.deepEqual(credentials.saved, []);
  });

  it('lets any session read who the admin is under CLAUDECODE', async () => {
    const { run } = teamWith();
    ok(await run(['owner', 'github-admin', 'alpha']));
    assert.match(ok(await run(['gh', 'admin'], UNDER_CLAUDE_CODE)).stdout.join(''), /^ADMIN alpha /);
  });
});
