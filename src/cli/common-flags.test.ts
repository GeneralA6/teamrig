import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { formatConfig } from '../config/load.ts';
import { readable } from '../slash/plan.ts';
import { APP, CliHarness, POINTER, TEAM } from '../testing/cli-harness.ts';
import { teamConfigOf } from '../testing/team-tree.ts';
import { parseArgs, UsageError } from './args.ts';
import { COMMAND_FLAGS, COMMAND_TABLE, USAGE } from './run.ts';
import { EXIT } from './runtime.ts';

const FOLDERS = new FakePathProbe({ folders: [APP] });

/** The usage error a line gives, or undefined when it reads. */
function usageOf(argv: readonly string[]): string | undefined {
  try {
    parseArgs(argv, COMMAND_TABLE.flags, COMMAND_TABLE.switches, COMMAND_TABLE.renamed, COMMAND_TABLE.rest);
    return undefined;
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }
    throw error;
  }
}

describe('--session and --team on every command (#654)', () => {
  it('reads both flags on every command of the command table', () => {
    const refused = Object.keys(COMMAND_FLAGS).flatMap((command) => {
      const why = usageOf([...command.split(' '), '--session', 'lead', '--team', 'app']);
      return why === undefined ? [] : [`${command}: ${why}`];
    });
    assert.deepEqual(refused, []);
  });

  it('still refuses another unknown flag as a usage error', () => {
    assert.equal(usageOf(['who', '--sesion', 'lead']), 'who takes no --sesion');
  });

  it('runs teamrig open with the caller named', async () => {
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await new CliHarness(TEAM).run(['open', 'alpha', '--session', 'lead'], { probe: FOLDERS, processes, platform: 'win32' });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(processes.started.length, 1);
  });

  it('runs a command that has no use for the caller as it runs without the flag', async () => {
    const kit = new CliHarness(TEAM);
    const plain = await kit.run(['who']);
    assert.deepEqual(await kit.run(['who', '--session', 'bravo']), plain);
    assert.deepEqual(await kit.run(['who', '--team', 'app']), plain);
  });

  it('keeps the undeclared common flags out of the flags as the line is read, so no reader of it sees them', () => {
    const args = readable(['exec', 'dry-run', 'R1', '--session', 'bravo', '--team', 'app'], COMMAND_TABLE);
    assert.deepEqual([[...(args?.flags ?? [])], [...(args?.common ?? [])], args?.positionals], [[], [['session', 'bravo'], ['team', 'app']], ['R1']]);
    const declared = readable(['exec', 'approve', 'R1', '--session', 'bravo', '--note', 'ok'], COMMAND_TABLE);
    assert.deepEqual([[...(declared?.flags ?? [])], [...(declared?.common ?? [])]], [[['session', 'bravo'], ['note', 'ok']], []]);
    assert.equal(usageOf(['exec', 'dry-run', 'R1', '--session', 'bravo', '--session', 'alpha']), '--session is given twice');
  });

  it('checks --session against the team a command declares --team for and was given, not this one', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(teamConfigOf('web'), formatConfig({ configVersion: 1, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } }));
    const ran = await kit.run(['exec', 'status', '--team', 'web', '--session', 'front']);
    assert.deepEqual(ran, await kit.run(['exec', 'status', '--team', 'web']), 'front is a session of web');
    const nobody = await kit.run(['exec', 'status', '--team', 'web', '--session', 'bravo']);
    assert.deepEqual(nobody.stdout, ['REFUSED --session bravo names no session of team web: teamrig who lists them']);
  });

  it('refuses with one line a --session that names no session of the team, on a command that ignores it', async () => {
    const result = await new CliHarness(TEAM).run(['doctor', '--session', 'nobody']);
    assert.equal(result.code, EXIT.refused);
    assert.equal(result.stdout.length, 1);
    assert.match(result.stdout[0] ?? '', /^REFUSED --session nobody names no session of team app/);
    assert.deepEqual(result.stderr, []);
  });

  it('refuses with one line a --team naming another team on a command that runs for its own team only', async () => {
    const result = await new CliHarness(TEAM).run(['who', '--team', 'web']);
    assert.deepEqual(result, { code: EXIT.refused, stdout: ['REFUSED teamrig who runs for this team (app) only; --team web names another team'], stderr: [] });
    const fromEnv = await new CliHarness(TEAM, null).run(['who', '--team', 'web'], { env: { TEAMRIG_TEAM: 'app' } });
    assert.deepEqual(fromEnv.stdout, ['REFUSED teamrig who runs for this team (app) only; --team web names another team'], 'a team from $TEAMRIG_TEAM too');
  });

  it('names a broken pointer when it refuses a --team, and leaves --session to the command there', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(POINTER, 'not json');
    const team = await kit.run(['who', '--team', 'web']);
    assert.match(team.stdout[0] ?? '', /^REFUSED teamrig who runs for this team only, and its pointer .+\.teamrig\.json is not JSON; expected \{"team": "<id>"\}; --team web names another team$/);
    assert.deepEqual(await kit.run(['who', '--session', 'nobody']), await kit.run(['who']));
  });

  it('with no team here, refuses any --team and leaves --session to the command', async () => {
    const kit = new CliHarness(TEAM, null);
    const team = await kit.run(['who', '--team', 'app']);
    assert.deepEqual(team.stdout, ['REFUSED teamrig who runs for the team of this folder, and none is found here; --team app names another team']);
    assert.deepEqual(await kit.run(['who', '--session', 'nobody']), await kit.run(['who']));
  });

  it('leaves --session to the command when the team config does not load', async () => {
    const kit = new CliHarness('{ not json');
    assert.deepEqual(await kit.run(['config', 'validate', '--session', 'nobody']), await kit.run(['config', 'validate']));
  });

  it('says so in the usage, the guide and the commands page', () => {
    const line = 'every command takes --session <id|name> and --team <team>';
    assert.ok(USAGE.includes(line), 'usage');
    for (const page of ['../../plugins/teamrig/skills/teamrig-guide/commands.md', '../../docs/commands.md']) {
      const text = readFileSync(new URL(page, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
      assert.ok(text.includes(line), page);
    }
  });
});
