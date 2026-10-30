import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const SOURCE = 'from the secret guard check [secretGuard]: SECRET-GUARD-OFF';
const OWNER_CALL = "Turning a secret check off is the owner's call: set it back unless the owner chose it.";
const USER_SETTINGS = join(USER_HOME, '.claude', 'settings.json');
const LOCAL_SETTINGS = join(APP, '.claude', 'settings.local.json');

/** The lead's check rows from the secret guard check. */
async function offRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' } });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('the secret guard check'));
}

describe('check SECRET-GUARD-OFF (T1369)', () => {
  it('flags each secret guard key that lets a secret through, with what it lets through', async () => {
    const kit = new CliHarness({ ...TEAM, secretGuard: { secretReads: 'allow', writes: 'allow', redact: false } });
    assert.deepEqual(await offRows(kit), [
      `${SOURCE} secretGuard.secretReads is allow: a call that would print a secret into a session runs unasked. ${OWNER_CALL}`,
      `${SOURCE} secretGuard.writes is allow: a command line or a written file that holds a secret as text runs unasked. ${OWNER_CALL}`,
      `${SOURCE} secretGuard.redact is false: a secret a call prints reaches the session unredacted. ${OWNER_CALL}`,
    ]);
  });

  it('flags nothing for the defaults, nor for a key that asks the human', async () => {
    assert.deepEqual(await offRows(new CliHarness(TEAM)), []);
    assert.deepEqual(await offRows(new CliHarness({ ...TEAM, secretGuard: { secretReads: 'ask', writes: 'ask' } })), []);
  });

  it('flags each settings file a session runs under that sets disableAllHooks, and passes one that does not or cannot be read', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(USER_SETTINGS, JSON.stringify({ disableAllHooks: true }));
    await kit.files.write(join(APP, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: false }));
    await kit.files.write(LOCAL_SETTINGS, '{ not json');
    assert.deepEqual(await offRows(kit), [
      `${SOURCE} ${USER_SETTINGS} sets disableAllHooks: no teamrig hook runs for a session under it, the secret guard included. ${OWNER_CALL}`,
    ]);
    await kit.files.write(LOCAL_SETTINGS, JSON.stringify({ disableAllHooks: true }));
    assert.equal((await offRows(kit)).length, 2);
  });

  it("tells the lead once from any session's start, while the check stays off", async () => {
    const kit = new CliHarness({ ...TEAM, secretGuard: { writes: 'allow' } });
    for (let run = 0; run < 2; run += 1) {
      assert.equal((await kit.run(['start'], { env: { TEAMRIG_SESSION: 'alpha' } })).code, EXIT.ok);
    }
    const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
    const lines = inbox.split('\n').filter((line) => line.includes('the secret guard check [secretGuard] raised a warning no session owns'));
    assert.equal(lines.length, 1, inbox);
    assert.match(lines[0] ?? '', /so it is yours as lead: SECRET-GUARD-OFF secretGuard\.writes is allow/);
  });
});
