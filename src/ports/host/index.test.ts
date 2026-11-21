import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_EVENTS, HOST_PORT_NAMES, SHELL_DIALECTS, TOOL_KINDS, isHookEventName, isToolKind, isUnsupported, unsupported, type HostPorts } from './index.ts';

describe('the host ports', () => {
  it('name the moments a host may call at, each once', () => {
    assert.equal(HOOK_EVENTS.length, 15);
    assert.equal(new Set<string>(HOOK_EVENTS).size, HOOK_EVENTS.length);
    assert.equal(isHookEventName('tool-start'), true);
    assert.equal(isHookEventName('other'), false);
    assert.equal(isHookEventName(undefined), false);
  });

  it('name the kinds of tool call, with one for every tool the core has no rule for', () => {
    assert.equal(new Set<string>(TOOL_KINDS).size, TOOL_KINDS.length);
    assert.equal(isToolKind('other'), true);
    assert.equal(isToolKind('task-input'), true);
    assert.equal(isToolKind('Bash'), false);
    assert.deepEqual(SHELL_DIALECTS, ['bash', 'powershell']);
  });

  it('list every port an adapter must name', () => {
    assert.deepEqual(HOST_PORT_NAMES, ['hooks', 'toolCall', 'transcripts', 'usage', 'statusLine', 'paths', 'permissions']);
  });
});

describe('an unsupported port', () => {
  it('carries its reason, and is told from a port that is filled', () => {
    const missing = unsupported('this host calls no hook');
    assert.deepEqual(missing, { kind: 'unsupported', notice: 'this host calls no hook' });
    const ports: HostPorts = {
      hooks: missing,
      toolCall: { normalize: (name, input) => ({ kind: 'other', name, input }) },
      transcripts: missing,
      usage: missing,
      statusLine: missing,
      paths: missing,
      permissions: missing,
    };
    assert.equal(isUnsupported(ports.hooks), true);
    assert.equal(isUnsupported(ports.toolCall), false);
  });

  it('is not a port that merely has a kind', () => {
    assert.equal(isUnsupported({ kind: 'unsupported' }), false);
    assert.equal(isUnsupported({ kind: 'other', notice: 'x' }), false);
  });
});
