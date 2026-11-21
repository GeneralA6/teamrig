import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hookBridge } from './hook-bridge.ts';
import { toolCallShape } from './tool-call.ts';

const bridge = hookBridge(toolCallShape('linux'));

describe("Antigravity's hook bridge", () => {
  it('returns undefined for invalid or non-object JSON', () => {
    assert.equal(bridge.parse(''), undefined);
    assert.equal(bridge.parse('{bad'), undefined);
    assert.equal(bridge.parse('[]'), undefined);
    assert.equal(bridge.parse('null'), undefined);
  });

  it('parses PreToolUse payload into HookEvent', () => {
    const event = bridge.parse(
      JSON.stringify({
        conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
        workspacePaths: ['/repo'],
        transcriptPath: '/repo/.gemini/antigravity/transcript.jsonl',
        modelName: 'auto',
        lastUserInput: 'Fix the test',
        hookEventName: 'PreToolUse',
        cwd: '/repo',
        toolCall: { id: 'toolu_01', name: 'run_command', args: { CommandLine: 'npm test' } },
      }),
    );
    assert.equal(event?.name, 'tool-start');
    assert.equal(event?.session, 'ec33ebf9-0cba-4100-8142-c61503f6c587');
    assert.equal(event?.cwd, '/repo');
    assert.equal(event?.prompt, 'Fix the test');
    assert.equal(event?.call?.kind, 'shell');
    assert.equal(event?.call?.id, 'toolu_01');
  });

  it('maps PostToolUse with error to tool-failed and Stop continuationActive', () => {
    const failed = bridge.parse(JSON.stringify({ hookEventName: 'PostToolUse', error: 'exit status 1' }));
    assert.equal(failed?.name, 'tool-failed');
    assert.equal(failed?.error, 'exit status 1');

    const stopped = bridge.parse(JSON.stringify({ hookEventName: 'Stop', continuationActive: true, terminationReason: 'NO_TOOL_CALL' }));
    assert.equal(stopped?.name, 'stop');
    assert.equal(stopped?.stopActive, true);
    assert.equal(stopped?.reason, 'NO_TOOL_CALL');
  });

  it('formats PreToolUse allow/deny replies', () => {
    assert.equal(bridge.reply('tool-start', {}), '');
    assert.deepEqual(JSON.parse(bridge.reply('tool-start', { verdict: { kind: 'allow', reason: 'safe read' } })), {
      decision: 'allow',
      reason: 'safe read',
    });
    assert.deepEqual(JSON.parse(bridge.reply('tool-start', { verdict: { kind: 'deny', reason: 'blocked push' } })), {
      decision: 'deny',
      reason: 'blocked push',
    });
  });

  it('formats SessionStart, PreInvocation, PostToolUse, and Stop replies', () => {
    assert.deepEqual(JSON.parse(bridge.reply('session-start', { context: 'team rules' })), {
      injectSteps: [{ systemMessage: { systemMessage: 'team rules' } }],
    });
    assert.deepEqual(JSON.parse(bridge.reply('prompt', { verdict: { kind: 'block', reason: 'secret detected' } })), {
      injectSteps: [{ errorMessage: { userMessage: 'secret detected' } }],
      terminationBehavior: 'terminate',
    });
    assert.deepEqual(JSON.parse(bridge.reply('tool-end', { context: 'ignored' })), {});
    assert.deepEqual(JSON.parse(bridge.reply('stop', { verdict: { kind: 'block', reason: 'keep going' } })), {
      decision: 'continue',
      reason: 'keep going',
    });
  });
});
