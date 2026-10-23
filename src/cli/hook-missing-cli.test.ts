import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CLAUDE_SESSION, CliHarness, TEAM } from '../testing/cli-harness.ts';

function shellFailure(error: string): string {
  return JSON.stringify({
    session_id: CLAUDE_SESSION,
    cwd: APP,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'teamrig list' },
    error,
  });
}

describe('the missing-cli hook', () => {
  it('tells the model to run the CLI its hooks run, by its path, after the shell did not find the bare command', async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['hook', 'missing-cli'], { stdin: shellFailure('Exit code 127\nbash: teamrig: command not found') });
    assert.equal(result.code, 0);
    const [line] = result.stdout;
    assert.ok(line !== undefined);
    assert.match(line, /"hookEventName":"PostToolUseFailure"/);
    assert.ok(line.includes('`node \\"/opt/teamrig/dist/cli/main.js\\" <command> ...`'));
  });

  it('answers outside a team too', async () => {
    const kit = new CliHarness(null, null);
    const result = await kit.run(['hook', 'missing-cli'], { stdin: shellFailure('bash: teamrig: command not found') });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 1);
  });

  it('prints nothing for any other failure or input that is not a payload', async () => {
    const kit = new CliHarness(TEAM);
    assert.deepEqual((await kit.run(['hook', 'missing-cli'], { stdin: shellFailure('Exit code 1\nfatal: not a git repository') })).stdout, []);
    assert.deepEqual((await kit.run(['hook', 'missing-cli'], { stdin: 'not json' })).stdout, []);
  });
});
