import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { teamInboxOf } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

/** A host scheduled job runs with no session of the team: no `--session`, no $TEAMRIG_SESSION. */
const NO_SESSION = { env: {} };

function inboxOf(kit: CliHarness, id: string): string | undefined {
  return kit.files.get(teamInboxOf('app', id));
}

describe('teamrig inbox add --from host:<job> (#930)', () => {
  it("posts one line to a session of the team, named by the job, with no session of the sender's", async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['inbox', 'add', '--from', 'host:nightly-backup', '--to', 'alpha', '--text', 'backup failed: disk full'], NO_SESSION);
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['POSTED to alpha; alpha is reminded at its next prompt'], stderr: [] });
    assert.equal(inboxOf(kit, 'alpha'), '- 2030-01-08 10:00 host:nightly-backup: backup failed: disk full\n');
  });

  it('refuses a --to that names no session, and a line past the inbox limits, as inbox add does', async () => {
    const kit = new CliHarness(TEAM);
    const fromSession = await kit.run(['inbox', 'add', '--session', 'lead', '--to', 'zulu', '--text', 'hi']);
    const fromHost = await kit.run(['inbox', 'add', '--from', 'host:job', '--to', 'zulu', '--text', 'hi'], NO_SESSION);
    assert.notEqual(fromHost.code, EXIT.ok);
    assert.deepEqual([fromHost.code, fromHost.stdout, fromHost.stderr], [fromSession.code, fromSession.stdout, fromSession.stderr]);
    const twoLines = await kit.run(['inbox', 'add', '--from', 'host:job', '--to', 'alpha', '--text', 'one\ntwo'], NO_SESSION);
    assert.notEqual(twoLines.code, EXIT.ok);
    assert.deepEqual(twoLines.stdout, ['REFUSED an inbox item is one non-empty line']);
    assert.equal(inboxOf(kit, 'alpha'), undefined);
  });

  it('refuses a group, a wake, a --session beside it and a sender that is not host:<job>', async () => {
    const kit = new CliHarness(TEAM);
    const refusals: readonly (readonly string[])[] = [
      ['--from', 'host:job', '--to', 'all', '--text', 'hi'],
      ['--from', 'host:job', '--to', 'alpha', '--text', 'hi', '--wake', 'now'],
      ['--from', 'host:job', '--to', 'alpha', '--text', 'hi', '--wake-by', '12:00'],
      ['--from', 'host:job', '--to', 'alpha', '--text', 'hi', '--session', 'lead'],
      ['--from', 'nightly', '--to', 'alpha', '--text', 'hi'],
      ['--from', 'host:', '--to', 'alpha', '--text', 'hi'],
      ['--from', 'host:Two Words', '--to', 'alpha', '--text', 'hi'],
    ];
    for (const words of refusals) {
      const result = await kit.run(['inbox', 'add', ...words], NO_SESSION);
      assert.notEqual(result.code, EXIT.ok, words.join(' '));
      assert.match([...result.stdout, ...result.stderr].join('\n'), /--from/, words.join(' '));
    }
    assert.equal(inboxOf(kit, 'alpha'), undefined);
  });

  it('refuses where Claude Code runs it, so an agent cannot post a line as a host job', async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['inbox', 'add', '--from', 'host:nightly-backup', '--to', 'alpha', '--text', 'hi'], { env: { CLAUDECODE: '1' } });
    assert.equal(result.code, EXIT.refused);
    assert.match([...result.stdout, ...result.stderr].join('\n'), /CLAUDECODE/);
    assert.equal(inboxOf(kit, 'alpha'), undefined);
  });
});
