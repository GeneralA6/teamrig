import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TempRepo } from '../lib/temp-repo.ts';
import { eventsOf, recordedInputs, recorderPlugin, RECORDER_SCRIPT } from './plugin.ts';

describe('eventsOf', () => {
  it('lists the events a hooks manifest wires, in its order', () => {
    assert.deepEqual(eventsOf({ hooks: { Stop: [], SessionStart: [], PreToolUse: [] } }), ['Stop', 'SessionStart', 'PreToolUse']);
  });

  it('lists none for what is not a hooks manifest', () => {
    for (const manifest of [undefined, 'hooks', [], {}, { hooks: [] }, { hooks: 'Stop' }]) {
      assert.deepEqual(eventsOf(manifest), []);
    }
  });
});

describe('recorderPlugin', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('record-plugin');
  });
  afterEach(() => repo.remove());

  it('wires one hook with no matcher per event, each running the recorder script from the plugin folder', () => {
    const files = recorderPlugin(['SessionStart', 'PreToolUse'], join(repo.outside, 'out.jsonl'));
    assert.deepEqual(Object.keys(files), ['.claude-plugin/plugin.json', 'hooks/hooks.json', RECORDER_SCRIPT]);
    assert.equal(JSON.parse(files['.claude-plugin/plugin.json'] ?? '').name, 'teamrig-recorder');
    const hook = { type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${RECORDER_SCRIPT}`], timeout: 15 };
    assert.deepEqual(JSON.parse(files['hooks/hooks.json'] ?? ''), {
      hooks: { SessionStart: [{ hooks: [hook] }], PreToolUse: [{ hooks: [hook] }] },
    });
  });

  it('records each input its script is given, as sent, in firing order, and prints nothing', () => {
    const outFile = join(repo.outside, 'out.jsonl');
    const script = repo.write(RECORDER_SCRIPT, recorderPlugin(['Stop'], outFile)[RECORDER_SCRIPT] ?? '');
    const first = '{"hook_event_name":"SessionStart",  "source":"startup"}\n';
    const second = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'two\nlines "quoted"' });
    for (const input of [first, second]) {
      const result = repo.run(script, [], {}, input);
      assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
    }
    const text = readFileSync(outFile, 'utf8');
    assert.deepEqual(
      text.split('\n').map((line) => (line === '' ? line : JSON.parse(line))),
      [first, second, ''],
    );
    assert.deepEqual(recordedInputs(text), [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'Stop', last_assistant_message: 'two\nlines "quoted"' },
    ]);
  });
});

describe('recordedInputs', () => {
  it('reads no input from an empty file', () => {
    assert.deepEqual(recordedInputs(''), []);
  });

  it('refuses a line that holds no JSON object, naming it', () => {
    const good = JSON.stringify(JSON.stringify({ hook_event_name: 'Stop' }));
    for (const bad of [JSON.stringify('[1, 2]'), JSON.stringify('"text"'), '{"hook_event_name":"Stop"}']) {
      assert.throws(() => recordedInputs(`${good}\n${bad}\n`), { message: 'recorded hook input 2 is not a JSON object' });
    }
  });

  it('refuses a torn line', () => {
    assert.throws(() => recordedInputs('"{\\"hook_event_name\\":'), SyntaxError);
  });
});
