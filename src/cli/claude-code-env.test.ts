import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness } from '../testing/cli-harness.ts';
import { underClaudeCode } from './claude-code-env.ts';

describe('underClaudeCode', () => {
  it('is true where Claude Code set CLAUDECODE, and false where it is unset or empty', () => {
    const kit = new CliHarness();
    assert.equal(underClaudeCode(kit.runtime({ env: { CLAUDECODE: '1' } })), true);
    assert.equal(underClaudeCode(kit.runtime({ env: { CLAUDECODE: '' } })), false);
    assert.equal(underClaudeCode(kit.runtime()), false);
  });
});
