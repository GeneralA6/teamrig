import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CLAUDE_SESSION, CliHarness, TEAM } from '../testing/cli-harness.ts';

function sendResult(to: string, toolResponse: unknown): string {
  return JSON.stringify({
    session_id: CLAUDE_SESSION,
    cwd: APP,
    hook_event_name: 'PostToolUse',
    tool_name: 'SendMessage',
    tool_input: { to, message: 'the ask' },
    tool_response: toolResponse,
  });
}

const NOT_REACHABLE = { success: false, message: 'No agent named that is reachable.' };

describe('the failed-send hook', () => {
  it('tells the model to leave a failed send to a team session as an inbox line', async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['hook', 'failed-send'], { stdin: sendResult('app-alpha', NOT_REACHABLE) });
    assert.equal(result.code, 0);
    const [line] = result.stdout;
    assert.ok(line !== undefined);
    assert.match(line, /"hookEventName":"PostToolUse"/);
    assert.ok(line.includes('the message to app-alpha was not sent (No agent named that is reachable.)'));
    assert.ok(line.includes("shown at alpha's next prompt: `teamrig inbox add --to alpha --text"));
    assert.ok(line.includes('or with `--wake now` if alpha must act on it now.'));
  });

  it('offers no --wake now on a team with wakes off', async () => {
    const kit = new CliHarness({ ...TEAM, wake: { enabled: false } });
    const result = await kit.run(['hook', 'failed-send'], { stdin: sendResult('app-alpha', NOT_REACHABLE) });
    assert.ok(result.stdout.join('\n').includes("shown at alpha's next prompt: `teamrig inbox add --to alpha --text"));
    assert.doesNotMatch(result.stdout.join('\n'), /--wake/);
  });

  it('points a name that is no team session to who', async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['hook', 'failed-send'], { stdin: sendResult('uds:old-pipe', NOT_REACHABLE) });
    assert.ok(result.stdout.join('\n').includes('uds:old-pipe is no team session name (`teamrig who` prints them)'));
  });

  it('says nothing after a delivered message', async () => {
    const kit = new CliHarness(TEAM);
    const result = await kit.run(['hook', 'failed-send'], { stdin: sendResult('alpha', { success: true, message: 'sent' }) });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, []);
  });
});
