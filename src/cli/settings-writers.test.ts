import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSettingsWriter, SETTINGS_WRITERS, settingsWriteRefusal, WRITE_SWITCH } from '../core/settings-writers.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { COMMAND_EFFECTS, COMMAND_SWITCHES } from './run.ts';
import { EXIT } from './runtime.ts';

const UNDER_CLAUDE_CODE = { env: { CLAUDECODE: '1' } };

/** Every settings writer, as its words: `permissions trim`. */
const WRITERS = [...SETTINGS_WRITERS].flatMap(([group, actions]) => [...actions].map((action) => `${group} ${action}`));

describe('settings writers where Claude Code runs them (T3083)', () => {
  it('names only write commands of the CLI that take --yes, and knows none else', () => {
    assert.equal(WRITERS.length, 7);
    for (const command of WRITERS) {
      assert.equal(COMMAND_EFFECTS[command], 'write', command);
      assert.ok(COMMAND_SWITCHES[command]?.includes(WRITE_SWITCH), command);
      assert.ok(isSettingsWriter(command), command);
    }
    for (const command of ['permissions', 'automode status', 'config get', 'setup', 'permissions trim --yes', 'statusline install extra']) {
      assert.equal(isSettingsWriter(command), false, command);
    }
  });

  it('refuses each one with --yes under CLAUDECODE before it loads, naming the routes the owner runs it by', async () => {
    const kit = new CliHarness();
    for (const command of WRITERS) {
      const result = await kit.run([...command.split(' '), `--${WRITE_SWITCH}`], UNDER_CLAUDE_CODE);
      assert.equal(result.code, EXIT.refused, command);
      assert.deepEqual(result.stdout, [`REFUSED ${settingsWriteRefusal(command)}`], command);
    }
    assert.match(
      settingsWriteRefusal('permissions trim'),
      /^`teamrig permissions trim --yes` changes Claude Code's settings, .* run it without --yes for its preview, and the owner types `\/teamrig permissions trim --yes` in a tab or runs it in their own terminal\.$/,
    );
  });

  it('leaves the preview, an empty CLAUDECODE and a run outside Claude Code to the command itself', async () => {
    const kit = new CliHarness();
    const refusedHere = (stdout: readonly string[]): boolean => stdout.some((line) => line.includes('is refused where Claude Code runs it'));
    for (const [argv, env] of [
      [['permissions', 'trim'], { CLAUDECODE: '1' }],
      [['statusline', 'install', '--yes'], { CLAUDECODE: '' }],
      [['config', 'migrate', '--yes'], {}],
    ] as const) {
      const result = await kit.run([...argv], { env });
      assert.equal(refusedHere(result.stdout), false, argv.join(' '));
    }
  });
});
