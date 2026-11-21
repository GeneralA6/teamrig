import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSettingsWriter, SETTINGS_WRITERS, settingsWriteRefusal, WRITE_SWITCH } from '../core/settings-writers.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { hostNaming, NO_MARK_HOST, NO_SESSION_HOST } from '../testing/host.ts';
import { COMMAND_EFFECTS, COMMAND_SWITCHES } from './run.ts';
import { EXIT } from './runtime.ts';

const UNDER_CLAUDE_CODE = { env: { CLAUDECODE: '1' } };
/** A host that is not shipped, naming a mark of its own. */
const OTHER_HOST = hostNaming({ marks: ['OTHER_AGENT'], identity: [] });

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
      assert.deepEqual(result.stdout, [`REFUSED ${settingsWriteRefusal(command, 'CLAUDECODE')}`], command);
    }
    assert.match(
      settingsWriteRefusal('permissions trim', 'CLAUDECODE'),
      /^`teamrig permissions trim --yes` changes Claude Code's settings, .* refused where Claude Code runs it \(CLAUDECODE is set: an agent's tool call, a script it runs or a hook\); run it without --yes for its preview, and the owner types `\/teamrig permissions trim --yes` in a tab or runs it in their own terminal\.$/,
    );
    assert.match(settingsWriteRefusal('permissions trim', undefined), / refused where Claude Code runs it \(an agent's tool call, a script it runs or a hook\); /);
  });

  it("refuses each one with --yes under a shipped host's mark whatever host runs, the mark named", async () => {
    const kit = new CliHarness();
    for (const host of [OTHER_HOST, NO_SESSION_HOST, NO_MARK_HOST]) {
      for (const command of WRITERS) {
        const result = await kit.run([...command.split(' '), `--${WRITE_SWITCH}`], { ...UNDER_CLAUDE_CODE, host });
        assert.deepEqual([result.code, result.stdout], [EXIT.refused, [`REFUSED ${settingsWriteRefusal(command, 'CLAUDECODE')}`]], command);
      }
    }
    const own = await kit.run(['permissions', 'trim', `--${WRITE_SWITCH}`], { env: { OTHER_AGENT: '1' }, host: OTHER_HOST });
    assert.deepEqual([own.code, own.stdout], [EXIT.refused, [`REFUSED ${settingsWriteRefusal('permissions trim', 'OTHER_AGENT')}`]]);
  });

  it("refuses each one with --yes on a host that tells no agent's run from the person's, with the host's reason, and still previews there", async () => {
    const kit = new CliHarness();
    for (const [host, notice] of [
      [NO_SESSION_HOST, 'no session of the host is told'],
      [NO_MARK_HOST, "its session launcher names no mark of an agent's run"],
    ] as const) {
      for (const command of WRITERS) {
        const result = await kit.run([...command.split(' '), `--${WRITE_SWITCH}`], { host });
        assert.equal(result.code, EXIT.refused, command);
        assert.deepEqual(
          result.stdout,
          [
            `REFUSED \`teamrig ${command} --yes\` is for the person alone, so it is refused on a host where an agent's run cannot be told from theirs (${notice}); the host's adapter must name a mark of an agent's run in its declaration's sessionVariables.marks and fill its session launcher port`,
          ],
          command,
        );
      }
      const preview = await kit.run(['permissions', 'trim'], { host });
      assert.equal(preview.stdout.some((line) => line.includes('is for the person alone')), false);
    }
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
