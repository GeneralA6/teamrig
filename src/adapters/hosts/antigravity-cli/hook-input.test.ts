import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANTIGRAVITY_HOOK_EVENTS, isAntigravityHookEvent } from './events.ts';
import { checkHookInput } from './hook-input.ts';
import { DOCS_BUILT_HOOK_INPUTS } from './testing/hook-inputs.ts';

const FIXTURES = Object.entries(DOCS_BUILT_HOOK_INPUTS);

function without(input: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(input).filter(([name]) => name !== key));
}

function reasonOf(event: string, payload: unknown): string {
  const check = checkHookInput(event, payload);
  assert.equal(check.ok, false);
  return check.ok ? '' : check.reason;
}

describe('the hook events Antigravity CLI fires', () => {
  it('are 6, each named once', () => {
    assert.equal(ANTIGRAVITY_HOOK_EVENTS.length, 6);
    assert.equal(new Set(ANTIGRAVITY_HOOK_EVENTS).size, 6);
  });

  it('leave out the events agy has no hook for', () => {
    for (const name of ['UserPromptSubmit', 'PermissionRequest', 'PreCompact', 'SessionEnd', 'SubagentStop', 'PostToolUseFailure']) {
      assert.equal(isAntigravityHookEvent(name), false, name);
    }
    assert.equal(isAntigravityHookEvent('PreInvocation'), true);
  });
});

describe('the docs-built hook inputs', () => {
  it('cover every event', () => {
    const covered = new Set(FIXTURES.map(([, fixture]) => fixture.event));
    assert.deepEqual([...covered].sort(), [...ANTIGRAVITY_HOOK_EVENTS].sort());
  });

  for (const [name, fixture] of FIXTURES) {
    it(`${name} fits its event's shape with no field the page does not name`, () => {
      assert.deepEqual(checkHookInput(fixture.event, fixture.input), { ok: true, event: fixture.event, unknownKeys: [] });
    });

    it(`${name} survives a trip through JSON, as agy sends it`, () => {
      const sent: unknown = JSON.parse(JSON.stringify(fixture.input));
      assert.deepEqual(checkHookInput(fixture.event, sent), { ok: true, event: fixture.event, unknownKeys: [] });
    });
  }
});

describe('checkHookInput', () => {
  const shell = DOCS_BUILT_HOOK_INPUTS.preToolUseShell.input;

  it('refuses an event agy does not fire, before reading the input', () => {
    for (const name of ['UserPromptSubmit', 'pretooluse', '']) {
      assert.equal(reasonOf(name, shell), `${name} is not an event Antigravity CLI fires`);
    }
  });

  it('refuses what is not a JSON object', () => {
    for (const payload of [null, undefined, 'PreToolUse', 7, [shell]]) {
      assert.equal(reasonOf('PreToolUse', payload), 'the PreToolUse hook input is not a JSON object');
    }
  });

  for (const [name, fixture] of FIXTURES) {
    it(`refuses ${name} without any one field its event must carry`, () => {
      const input: Readonly<Record<string, unknown>> = fixture.input;
      for (const key of Object.keys(input)) {
        if (key === 'lastUserInput') {
          continue;
        }
        assert.equal(reasonOf(fixture.event, without(input, key)), `the ${fixture.event} hook input has no ${key}`);
      }
    });
  }

  it('takes an input with or without the last prompt, which only newer builds send', () => {
    const withPrompt = DOCS_BUILT_HOOK_INPUTS.preInvocation.input;
    assert.equal(checkHookInput('PreInvocation', without(withPrompt, 'lastUserInput')).ok, true);
    assert.equal(
      reasonOf('PreInvocation', { ...withPrompt, lastUserInput: null }),
      'the PreInvocation hook input holds a lastUserInput that is not a string',
    );
  });

  it('refuses a field of the wrong type, naming what it must be', () => {
    assert.equal(reasonOf('PreToolUse', { ...shell, conversationId: 7 }), 'the PreToolUse hook input holds a conversationId that is not a string');
    assert.equal(
      reasonOf('PreToolUse', { ...shell, workspacePaths: '/work/project' }),
      'the PreToolUse hook input holds a workspacePaths that is not a list of strings',
    );
    assert.equal(
      reasonOf('PreToolUse', { ...shell, workspacePaths: ['/work/project', 3] }),
      'the PreToolUse hook input holds a workspacePaths that is not a list of strings',
    );
    assert.equal(
      reasonOf('Stop', { ...DOCS_BUILT_HOOK_INPUTS.stop.input, fullyIdle: 'yes' }),
      'the Stop hook input holds a fullyIdle that is not a boolean',
    );
  });

  it('takes only a whole number of 0 or more as a count', () => {
    for (const stepIdx of [-1, 1.5, '3', Number.NaN]) {
      assert.equal(reasonOf('PreToolUse', { ...shell, stepIdx }), 'the PreToolUse hook input holds a stepIdx that is not a whole number');
    }
    assert.equal(checkHookInput('PreToolUse', { ...shell, stepIdx: 0 }).ok, true);
  });

  it('refuses a tool call with no text name or no object of arguments', () => {
    for (const toolCall of [{ args: {} }, { name: 3, args: {} }, { name: 'run_command' }, { name: 'run_command', args: [] }, 'run_command']) {
      assert.equal(reasonOf('PreToolUse', { ...shell, toolCall }), 'the PreToolUse hook input holds a toolCall that is not a tool call');
    }
  });

  it('refuses a null tool call before the call runs, and takes one after it ran', () => {
    assert.equal(reasonOf('PreToolUse', { ...shell, toolCall: null }), 'the PreToolUse hook input holds a toolCall that is not a tool call');
    assert.equal(checkHookInput('PostToolUse', { ...DOCS_BUILT_HOOK_INPUTS.postToolUseShell.input, toolCall: null }).ok, true);
  });

  it('takes a stop reason the page does not list, as a live log saw', () => {
    assert.equal(checkHookInput('Stop', { ...DOCS_BUILT_HOOK_INPUTS.stop.input, terminationReason: 'NO_TOOL_CALL' }).ok, true);
  });

  it('reports a field the page does not name and still takes the input', () => {
    assert.deepEqual(checkHookInput('PreToolUse', { ...shell, hookEventName: 'PreToolUse', effort: 'high' }), {
      ok: true,
      event: 'PreToolUse',
      unknownKeys: ['hookEventName', 'effort'],
    });
  });

  it('holds an input to its own event, so a Stop input is refused as a PreToolUse', () => {
    assert.equal(reasonOf('PreToolUse', DOCS_BUILT_HOOK_INPUTS.stop.input), 'the PreToolUse hook input has no toolCall');
  });
});
