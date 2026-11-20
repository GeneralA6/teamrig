import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hookEventOf, SHIPPED_HOST, testHooks } from './host.ts';
import { quietWorld } from './quiet-world.ts';

const SHELL_START = { hook_event_name: 'PreToolUse', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'echo a\\\\b' } };

describe('the spec helpers of the shipped host', () => {
  it('read a hook input as the host sends it into the event the core reads', () => {
    const event = hookEventOf(SHELL_START);
    assert.equal(event.name, 'tool-start');
    assert.equal(event.cwd, '/repo');
    assert.equal(event.call?.kind === 'shell' && event.call.command, 'echo a\\\\b');
  });

  it('read it for the platform a spec names', () => {
    const readings = (platform: NodeJS.Platform): readonly string[] | undefined => {
      const { call } = hookEventOf(SHELL_START, platform);
      return call?.kind === 'shell' ? call.readings : undefined;
    };
    assert.deepEqual(readings('linux'), ['echo a\\\\b']);
    assert.deepEqual(readings('win32'), ['echo a\\\\b', 'echo a\\b']);
  });

  it('give the bridge that words a reply', () => {
    assert.equal(testHooks().reply('prompt', { context: 'one line' }), 'one line');
  });

  it('share the host the quiet world runs with', () => {
    assert.equal(quietWorld().host, SHIPPED_HOST);
  });
});
