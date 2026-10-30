import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigLoad } from '../config/load.ts';
import { testConfig } from '../testing/config.ts';
import { redactableResultOf, redactedLine, rotationText, rotatorOf } from './secret-redact.ts';

const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));

const bashResult = (stdout: string): { stdout: string; stderr: string; interrupted: boolean; isImage: boolean } => ({ stdout, stderr: '', interrupted: false, isImage: false });

const loaded = (roles: { lead: string; securityReviewer?: string }): ConfigLoad => ({ status: 'loaded', path: 'c.json', config: testConfig({ roles }), issues: [] });

describe('redactableResultOf', () => {
  it('gives the result of a Bash, PowerShell or Grep call, and of a Read of a text file, with its tool and payload', () => {
    for (const tool_name of ['Bash', 'PowerShell', 'Grep']) {
      const payload = { tool_name, tool_response: bashResult(TOKEN) };
      assert.deepEqual(redactableResultOf(payload), { payload, tool: tool_name, response: bashResult(TOKEN) });
    }
    const text = { type: 'text', file: { filePath: 'a.txt', content: TOKEN } };
    assert.deepEqual(redactableResultOf({ tool_name: 'Read', tool_response: text })?.response, text);
  });

  it('leaves a tool not probed, a Read of an image, a result that is no object and a payload that is none alone', () => {
    assert.equal(redactableResultOf({ tool_name: 'WebFetch', tool_response: { result: TOKEN } }), undefined);
    assert.equal(redactableResultOf({ tool_name: 'Read', tool_response: { type: 'image', file: { base64: TOKEN } } }), undefined);
    assert.equal(redactableResultOf({ tool_name: 'Bash', tool_response: JSON.stringify(bashResult(TOKEN)) }), undefined);
    assert.equal(redactableResultOf({ tool_name: 'Bash' }), undefined);
    assert.equal(redactableResultOf({ tool_response: bashResult(TOKEN) }), undefined);
    assert.equal(redactableResultOf('not a payload'), undefined);
  });
});

describe('rotatorOf', () => {
  it("names the team's security reviewer, else its lead, else the lead in words when no config loaded", () => {
    assert.equal(rotatorOf(loaded({ lead: 'lead', securityReviewer: 'bravo' })), 'bravo');
    assert.equal(rotatorOf(loaded({ lead: 'alpha' })), 'alpha');
    assert.equal(rotatorOf({ status: 'missing', path: 'c.json' }), 'the lead');
    assert.equal(rotatorOf(undefined), 'the lead');
  });
});

describe('rotationText', () => {
  it('names each rotation task once when every kind has one', () => {
    assert.equal(rotationText('bravo', [{ kind: 'GitHub token', task: 'T7' }, { kind: 'AWS key', task: 'T8' }, { kind: 'npm token', task: 'T7' }]), 'bravo rotates it in T7, T8.');
  });

  it('asks the model to file the task when no kind has one, naming each problem once', () => {
    const failed = [{ kind: 'GitHub token', problem: 'the register is locked' }, { kind: 'AWS key', problem: 'the register is locked' }];
    assert.equal(rotationText('bravo', failed), 'ask bravo to rotate it with a register task (filing one failed: the register is locked).');
  });

  it('names the tasks filed and asks for the rest when only some kinds have one', () => {
    assert.equal(
      rotationText('app/security', [{ kind: 'GitHub token', task: 'app/T3' }, { kind: 'AWS key', problem: 'no route' }]),
      'app/security rotates it in app/T3; ask app/security to rotate the rest with a register task (filing one failed: no route).',
    );
  });
});

describe('redactedLine', () => {
  it('names each kind found and what becomes of it, never a value, and says when part of the result went unscanned', () => {
    const whole = redactedLine({ classes: ['GitHub token', 'secret variable value'], cut: false }, 'bravo rotates it in T7.');
    assert.match(whole, /\(GitHub token, secret variable value\)/);
    assert.match(whole, /Treat it as leaked: bravo rotates it in T7\. Do not print it again\.$/);
    assert.match(redactedLine({ classes: ['GitHub token'], cut: true },'bravo rotates it in T7.'), /past the scan's cap and was not checked\.$/);
  });
});
