import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { SERVICE_COMMAND_REACH } from '../permissions/service-commands.ts';
import { CliHarness, CONFIG_PATH, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { EXIT } from './runtime.ts';

const TEAM: JsonRecord = { sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' } };

function rolesOf(kit: CliHarness): unknown {
  const text = kit.files.get(CONFIG_PATH);
  const config: unknown = text === undefined ? undefined : JSON.parse(text);
  assert.ok(isRecord(config));
  return config['serviceRoles'];
}

function refusal(result: CliResult): string {
  assert.equal(result.code, EXIT.refused, result.stdout.join('\n'));
  return result.stdout.join('\n');
}

describe('roles grant, revoke and list', () => {
  it('previews a grant and writes nothing without --yes', async () => {
    const kit = new CliHarness(TEAM);
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await kit.run(['roles', 'grant', 'github', '--holder', 'alpha', '--commands', 'issue close']));
    assert.deepEqual(result.stdout, [
      'PREVIEW roles grant github: held by alpha; runs issue close; nothing written (add --yes to write)',
      `REACH issue close: ${SERVICE_COMMAND_REACH['issue close']}`,
    ]);
    assert.match(result.stdout.join('\n'), /any issue or pull request of github.repos, an outside author's too/, 'a grant says it reaches pull requests (T2984)');
    assert.equal(kit.files.get(CONFIG_PATH), before);
  });

  it('writes the role with --yes, keeps the old config, adds a holder and lists them', async () => {
    const kit = new CliHarness(TEAM);
    const before = kit.files.get(CONFIG_PATH);
    const result = ok(await kit.run(['roles', 'grant', 'github', '--holder', 'alpha', '--commands', 'issue close', '--yes']));
    assert.match(result.stdout[0] ?? '', /^GRANTED github: held by alpha; runs issue close; the old config is at .*config\.roles-grant\.json$/);
    assert.deepEqual(result.stdout.slice(1), [`REACH issue close: ${SERVICE_COMMAND_REACH['issue close']}`]);
    assert.equal(kit.files.get(join(TEAM_HOME, 'backups', 'config.roles-grant.json')), before);
    assert.deepEqual(rolesOf(kit), { github: { holders: ['alpha'], commands: ['issue close'] } });
    ok(await kit.run(['config', 'validate']));
    ok(await kit.run(['roles', 'grant', 'github', '--holder', 'bravo', '--yes']));
    assert.deepEqual(rolesOf(kit), { github: { holders: ['alpha', 'bravo'], commands: ['issue close'] } });
    assert.deepEqual(ok(await kit.run(['roles', 'list'])).stdout, ['github: held by alpha, bravo; runs issue close']);
  });

  it('revokes one holder, then the whole role, dropping serviceRoles once empty', async () => {
    const kit = new CliHarness({ ...TEAM, serviceRoles: { github: { holders: ['alpha', 'bravo'], commands: ['issue close'] } } });
    const one = ok(await kit.run(['roles', 'revoke', 'github', '--holder', 'alpha', '--yes']));
    assert.match(one.stdout[0] ?? '', /^REVOKED github: held by bravo; runs issue close; the old config is at .*config\.roles-revoke\.json$/);
    assert.deepEqual(rolesOf(kit), { github: { holders: ['bravo'], commands: ['issue close'] } });
    const all = ok(await kit.run(['roles', 'revoke', 'github', '--yes']));
    assert.match(all.stdout[0] ?? '', /^REVOKED github: no role; the old config is at /);
    assert.equal(rolesOf(kit), undefined);
    assert.deepEqual(ok(await kit.run(['roles', 'list'])).stdout, [
      'no service roles; the owner grants one with `teamrig roles grant <role> --holder <id> --commands <a,b> --yes`',
    ]);
  });

  it('refuses a team holder for a command that acts as whoever runs it, writing nothing', async () => {
    const kit = new CliHarness(TEAM);
    const before = kit.files.get(CONFIG_PATH);
    assert.match(refusal(await kit.run(['roles', 'grant', 'github', '--holder', 'team', '--commands', 'issue close', '--yes'])), /name the sessions that hold it/);
    assert.equal(kit.files.get(CONFIG_PATH), before);
  });

  it('refuses an unknown holder, a role that is not there and a bad role name', async () => {
    const kit = new CliHarness(TEAM);
    assert.notEqual((await kit.run(['roles', 'grant', 'github', '--holder', 'zulu', '--commands', 'issue close'])).code, EXIT.ok);
    assert.match(refusal(await kit.run(['roles', 'revoke', 'github'])), /there is no role github/);
    assert.match(refusal(await kit.run(['roles', 'grant', 'Git Hub', '--holder', 'alpha', '--commands', 'issue close'])), /new config cannot be read|serviceRoles/);
  });

  it('refuses a command outside the table and a grant without --holder as usage errors', async () => {
    const kit = new CliHarness(TEAM);
    const unknown = await kit.run(['roles', 'grant', 'github', '--holder', 'alpha', '--commands', 'pr merge']);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.stderr.join('\n'), /"pr merge" is no command a service role may hold; one of: issue close/);
    const comment = await kit.run(['roles', 'grant', 'github', '--holder', 'alpha', '--commands', 'issue comment']);
    assert.equal(comment.code, EXIT.usage, 'a bare comment is no command a role holds (T3169)');
    assert.match(comment.stderr.join('\n'), /"issue comment" is no command a service role may hold; one of: issue close, queue ship, queue merge$/m);
    assert.equal((await kit.run(['roles', 'grant', 'github', '--commands', 'issue close'])).code, EXIT.usage);
  });
});
