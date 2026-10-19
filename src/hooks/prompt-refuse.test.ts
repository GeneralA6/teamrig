import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';
import { promptRefusedReason, promptRefuseOutput, refusedTool } from './prompt-refuse.ts';

function request(tool: string, fields: JsonRecord = {}): JsonRecord {
  return { hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: {}, ...fields };
}

describe('refusedTool', () => {
  it('names the tool of a permission prompt when asks are off', () => {
    assert.equal(refusedTool('refuse', request('Bash')), 'Bash');
    assert.equal(refusedTool('refuse', request('mcp__docs__update')), 'mcp__docs__update');
  });

  it('lets the prompt open with asks on, for a question to the person, another event or no tool', () => {
    assert.equal(refusedTool('ask', request('Bash')), undefined);
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      assert.equal(refusedTool('refuse', request(tool)), undefined, tool);
    }
    assert.equal(refusedTool('refuse', request('Bash', { hook_event_name: 'PreToolUse' })), undefined);
    assert.equal(refusedTool('refuse', { hook_event_name: 'PermissionRequest' }), undefined);
  });
});

describe('promptRefuseOutput', () => {
  it('is a PermissionRequest deny whose message names the call and says what to do instead', () => {
    assert.deepEqual(JSON.parse(promptRefuseOutput(promptRefusedReason('Bash'))), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: `Claude Code would ask a person to allow this Bash call. ${ASK_REFUSED_NOTE}` },
      },
    });
  });
});
