import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PromptSecret } from '../secret-guard/prompt-secrets.ts';
import { promptBlockOutput, promptSecretReason } from './prompt-secret.ts';

const GITHUB: PromptSecret = { id: 'github-token', description: 'GitHub token', hash: 'a'.repeat(64) };
const URL_CREDENTIALS: PromptSecret = { id: 'url-credentials', description: 'credentials in a URL', hash: 'b'.repeat(64) };

describe('promptSecretReason', () => {
  it('names each shape once, what to send instead and that the value is leaked', () => {
    const reason = promptSecretReason([GITHUB, { ...GITHUB, hash: 'c'.repeat(64) }, URL_CREDENTIALS], { kind: 'cleaned', lines: 0, pastes: 0 });
    assert.equal(
      reason,
      'teamrig stopped this prompt before Claude read it: it looks like it holds a secret (GitHub token, credentials in a URL). Send its name or the file it is kept in instead; the value counts as leaked: rotate it.',
    );
  });

  it('says what the clean removed, and whether a failed one is tried again', () => {
    assert.match(promptSecretReason([GITHUB], { kind: 'cleaned', lines: 1, pastes: 2 }), /rotate it\. Removed from Claude Code's prompt history: 1 line and 2 pasted texts that held it\.$/);
    assert.match(promptSecretReason([GITHUB], { kind: 'cleaned', lines: 3, pastes: 1 }), /3 lines and 1 pasted text that/);
    assert.match(promptSecretReason([GITHUB], { kind: 'retry' }), /failed; your next prompt tries again\.$/);
    assert.match(promptSecretReason([GITHUB], { kind: 'failed' }), /failed: an earlier prompt that held it may stay in history\.jsonl\.$/);
  });

  it('never holds a hash', () => {
    assert.doesNotMatch(promptSecretReason([GITHUB], { kind: 'cleaned', lines: 1, pastes: 0 }), /a{64}/);
  });
});

describe('promptBlockOutput', () => {
  it('blocks the prompt with its reason and keeps it out of the transcript', () => {
    assert.deepEqual(JSON.parse(promptBlockOutput('why')), {
      decision: 'block',
      reason: 'why',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    });
  });
});
