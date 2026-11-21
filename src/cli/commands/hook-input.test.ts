import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replyText } from '../../testing/host.ts';
import { quietWorld } from '../../testing/quiet-world.ts';
import type { CliRuntime } from '../runtime.ts';
import { readHookInput, readModRequest, writeReply } from './hook-input.ts';

interface HookRun {
  readonly runtime: Pick<CliRuntime, 'readStdin' | 'out' | 'host' | 'env' | 'platform'>;
  /** What the hook printed, a line per entry. */
  readonly stdout: readonly string[];
}

/** A hook's run in the quiet world, on the shipped host, with `stdin` on its standard input. */
function hookRun(stdin: string = ''): HookRun {
  const world = quietWorld('dev', stdin);
  const stdout: string[] = [];
  const out = { stdout: (line: string): void => void stdout.push(line), stderr: (): void => undefined };
  return { runtime: { readStdin: world.readStdin, out, host: world.host, env: {}, platform: world.platform }, stdout };
}

const SESSION = '0a1b2c3d-0000-4000-8000-0123456789ab';

describe('readHookInput', () => {
  it("gives the event the host's bridge reads out of the input, and nothing of the input beside it", async () => {
    const payload = { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'git status' } };
    const input = await readHookInput(hookRun(JSON.stringify(payload)).runtime);
    assert.deepEqual(Object.keys(input), ['event']);
    assert.equal(input.event?.name, 'tool-start');
    assert.equal(input.event?.session, SESSION);
    assert.equal(input.event?.call?.kind === 'shell' && input.event.call.command, 'git status');
  });

  it('gives no event for input that is no hook input', async () => {
    assert.deepEqual(await readHookInput(hookRun('not json').runtime), { event: undefined });
    assert.deepEqual(await readHookInput(hookRun('').runtime), { event: undefined });
  });
});

describe('readModRequest', () => {
  it("gives the event the host's bridge reads out of the request beside the fields the mod wrote", async () => {
    const request = await readModRequest(hookRun(JSON.stringify({ session_id: SESSION, cwd: '/repo', tokens: 120000 })).runtime);
    assert.equal(request?.event.name, 'other');
    assert.equal(request?.event.session, SESSION);
    assert.equal(request?.event.cwd, '/repo');
    assert.deepEqual(request?.fields, { session_id: SESSION, cwd: '/repo', tokens: 120000 });
  });

  it('gives no request for input that is no JSON record', async () => {
    for (const stdin of ['not json', '', '[1]', '"text"', 'null']) {
      assert.equal(await readModRequest(hookRun(stdin).runtime), undefined, stdin);
    }
  });
});

describe('writeReply', () => {
  it('prints a reply once, worded as the host reads it', () => {
    const run = hookRun();
    const reply = { verdict: { kind: 'deny', reason: 'Why.' } } as const;
    writeReply(run.runtime, 'tool-start', reply);
    assert.deepEqual(run.stdout, [replyText('tool-start', reply)]);
    assert.notEqual(run.stdout[0], '');
  });

  it('prints nothing when the hook has nothing to say', () => {
    const run = hookRun();
    writeReply(run.runtime, 'tool-start', undefined);
    writeReply(run.runtime, 'tool-start', {});
    assert.deepEqual(run.stdout, []);
  });
});
