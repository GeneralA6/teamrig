import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigLoad } from '../config/load.ts';
import type { SecretShapeHit } from '../core/secret-shapes.ts';
import { ToolOutputRedactor, type SecretFinder } from '../secret-guard/redactor.ts';
import { testConfig } from '../testing/config.ts';
import { redactableResultOf, redactedLine, rotatorOf, secretRedactOutput } from './secret-redact.ts';

const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));

/** Finds `TOKEN` and nothing else, so these specs judge the hook, not the shapes. */
class TokenFinder implements SecretFinder {
  hitsIn(text: string): readonly SecretShapeHit[] {
    return text.includes(TOKEN) ? [{ id: 'github-token', description: 'GitHub token', value: TOKEN }] : [];
  }
}

const REDACTOR = new ToolOutputRedactor([new TokenFinder()]);

const bashResult = (stdout: string): { stdout: string; stderr: string; interrupted: boolean; isImage: boolean } => ({ stdout, stderr: '', interrupted: false, isImage: false });

const loaded = (roles: { lead: string; securityReviewer?: string }): ConfigLoad => ({ status: 'loaded', path: 'c.json', config: testConfig({ roles }), issues: [] });

describe('redactableResultOf', () => {
  it('gives the result of a Bash, PowerShell or Grep call, and of a Read of a text file', () => {
    for (const tool_name of ['Bash', 'PowerShell', 'Grep']) {
      assert.deepEqual(redactableResultOf({ tool_name, tool_response: bashResult(TOKEN) }), bashResult(TOKEN));
    }
    const text = { type: 'text', file: { filePath: 'a.txt', content: TOKEN } };
    assert.deepEqual(redactableResultOf({ tool_name: 'Read', tool_response: text }), text);
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

describe('redactedLine', () => {
  it('names each kind found and who rotates it, never a value, and says when part of the result went unscanned', () => {
    const whole = redactedLine({ response: {}, classes: ['GitHub token', 'secret variable value'], cut: false }, 'bravo');
    assert.match(whole, /\(GitHub token, secret variable value\)/);
    assert.match(whole, /ask bravo to rotate it/);
    assert.doesNotMatch(whole, /cap/);
    assert.match(redactedLine({ response: {}, classes: ['GitHub token'], cut: true }, 'bravo'), /past the scan's cap and was not checked\.$/);
  });
});

describe('secretRedactOutput', () => {
  it('hands back the result with its secret replaced, every other key kept, and the line as context', () => {
    const output = secretRedactOutput({ tool_name: 'Bash', tool_response: bashResult(join('token ', TOKEN)) }, REDACTOR, 'bravo');
    assert.deepEqual(JSON.parse(output ?? ''), {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: bashResult('token [redacted GitHub token]'),
        additionalContext: redactedLine({ response: {}, classes: ['GitHub token'], cut: false }, 'bravo'),
      },
    });
  });

  it('prints nothing for a result that holds no secret or that it does not redact', () => {
    assert.equal(secretRedactOutput({ tool_name: 'Bash', tool_response: bashResult('all clear') }, REDACTOR, 'bravo'), undefined);
    assert.equal(secretRedactOutput({ tool_name: 'WebFetch', tool_response: { result: TOKEN } }, REDACTOR, 'bravo'), undefined);
  });
});
