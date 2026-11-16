import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
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

  it('refuses with one line a --session that names no session of the team, on a command that ignores it', async () => {
    const result = await new CliHarness(TEAM).run(['doctor', '--session', 'nobody']);
    assert.equal(result.code, EXIT.refused);
    assert.equal(result.stdout.length, 1);
    assert.match(result.stdout[0] ?? '', /^REFUSED --session nobody names no session of team app/);
    assert.deepEqual(result.stderr, []);
  });

  it('refuses with one line a --team naming another team on a command that runs for its own team only', async () => {
    const result = await new CliHarness(TEAM).run(['who', '--team', 'web']);
    assert.deepEqual(result, { code: EXIT.refused, stdout: ['REFUSED teamrig who runs for this folder\'s team (app) only; --team web names another team'], stderr: [] });
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
