import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const LEAD_UNSET =
  'You are the `lead` session of team `app` (name `app-lead`, roles: lead). $TEAMRIG_SESSION is not set here, so pass --session lead to every `teamrig` task and inbox command.';

function textOf(result: CliResult): string {
  assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
  assert.equal(result.stdout.length, 1);
  return result.stdout[0] ?? '';
}

describe('teamrig rules', () => {
  it('gives a tab with no session set the rules and its identity, and tells it to pass --session', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(TEAM_HOME, 'rules.md'), 'Ship small.');
    const text = textOf(await kit.run(['rules', '--session', 'lead']));
    assert.match(text, /^# Team rules \(teamrig core\)/);
    assert.ok(text.includes(`\n\n${LEAD_UNSET}\n`));
    assert.ok(text.endsWith("# Your team's rules\nShip small."));
  });

  it('takes the session from $TEAMRIG_SESSION without the note, and asks when there is none', async () => {
    const kit = new CliHarness(TEAM);
    const fromEnv = textOf(await kit.run(['rules'], { env: { TEAMRIG_SESSION: 'alpha' } }));
    assert.ok(fromEnv.includes('You are the `alpha` session of team `app` (name `app-alpha`). Message the lead as `app-lead`.\n'));
    const none = textOf(await kit.run(['rules'], { env: { TEAMRIG_SESSION: ' ' } }));
    assert.match(none, /No session is set \(\$TEAMRIG_SESSION\): ask the user which session you are/);
  });

  it('refuses a session not on the team, and a team with no config', async () => {
    const unknown = await new CliHarness(TEAM).run(['rules', '--session', 'zulu']);
    assert.equal(unknown.code, EXIT.refused);
    assert.match(unknown.stdout[0] ?? '', /^REFUSED .*zulu/);
    const noConfig = await new CliHarness(null).run(['rules']);
    assert.equal(noConfig.code, EXIT.refused);
    assert.match(noConfig.stdout[0] ?? '', /^REFUSED no team config at .*; create it with: teamrig team create app --sessions <id,id>$/);
  });
});
