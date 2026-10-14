import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePrompt, defaultPrompt, encodePrompt, PROMPT_MAX, promptProblem } from './prompt.ts';

describe('defaultPrompt', () => {
  it('names the session and its team, and starts with the inbox and the task list', () => {
    assert.equal(
      defaultPrompt('shop', 'api'),
      'You are the api session of team shop. Run `teamrig inbox read`, then `teamrig list --session api`, and start your first open task.',
    );
    assert.equal(promptProblem(defaultPrompt('shop', 'api')), undefined);
  });
});

describe('promptProblem', () => {
  it('refuses a prompt Claude Code would misread or that is too long', () => {
    assert.equal(promptProblem('  \n'), 'the prompt is empty');
    assert.equal(promptProblem('--dangerously-skip-permissions'), 'the prompt cannot start with -');
    assert.equal(promptProblem('x'.repeat(PROMPT_MAX)), undefined);
    assert.match(promptProblem('x'.repeat(PROMPT_MAX + 1)) ?? '', /over 2000 characters/);
    assert.equal(promptProblem('a\0b'), 'the prompt contains a NUL character');
  });
});

describe('encodePrompt and decodePrompt', () => {
  it('round-trips hostile text as letters, digits, - and _ only', () => {
    const hostile = `Fix "it"; rm -rf / & echo $(id) | cat \`id\` %PATH% 'q' ’ \n next line, café`;
    const encoded = encodePrompt(hostile);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodePrompt(encoded), hostile);
  });

  it('refuses text it did not make', () => {
    assert.equal(decodePrompt('abc$'), undefined);
    assert.equal(decodePrompt('a+b/'), undefined);
    // Valid letters, but not what encodePrompt gives for any text: a lone trailing character.
    assert.equal(decodePrompt('QUJDa'), undefined);
    assert.equal(decodePrompt(''), '');
  });
});
