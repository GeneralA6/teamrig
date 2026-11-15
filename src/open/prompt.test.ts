import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePrompt, defaultPrompt, encodePrompt, meetAsk, meetPrompt, PROMPT_MAX, promptProblem, recoverPrompt, refreshPrompt, rehirePrompt, reopenPrompt, resumePrompt } from './prompt.ts';

describe('recoverPrompt', () => {
  it('tells a session resumed after its tab ended outside teamrig that its tasks may have moved', () => {
    const recovered = recoverPrompt('shop', 'api');
    assert.match(recovered, /^You are the api session of team shop, resumed in your last Claude Code session after its tab ended\. Your tasks may have moved since: run `teamrig inbox read` and `teamrig list --session api`/);
    assert.equal(promptProblem(recovered), undefined);
  });
});

describe('defaultPrompt', () => {
  it('names the session and its team, and starts with the inbox and the task list', () => {
    assert.equal(
      defaultPrompt('shop', 'api'),
      'You are the api session of team shop. Run `teamrig inbox read`, then `teamrig list --session api`, and start your first open task.',
    );
    assert.equal(promptProblem(defaultPrompt('shop', 'api')), undefined);
  });
});

describe('refreshPrompt', () => {
  it('sends a session the restart started fresh to its handover before the inbox and the task list', () => {
    const prompt = refreshPrompt('shop', 'api', '/cfg/handover/api.md');
    assert.equal(
      prompt,
      'You are the api session of team shop, started fresh after a context refresh. Read your handover /cfg/handover/api.md first and carry on with its next steps, then run `teamrig inbox read` and `teamrig list --session api`.',
    );
    assert.equal(promptProblem(prompt), undefined);
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

describe('rehirePrompt and resumePrompt', () => {
  it('send a rehired session to the handover it left, or, resumed, to its moved tasks', () => {
    const fresh = rehirePrompt('shop', 'api', '/cfg/handover/api.md');
    assert.equal(
      fresh,
      'You are the api session of team shop, hired back after a retire. Read the handover your last run left, /cfg/handover/api.md, first, then run `teamrig inbox read` and `teamrig list --session api`, and start your first open task.',
    );
    const resumed = resumePrompt('shop', 'api');
    assert.match(resumed, /^You are the api session of team shop, hired back after a retire and resumed in your last Claude Code session\. Your tasks may have moved since: run `teamrig inbox read`/);
    assert.equal(promptProblem(fresh), undefined);
    assert.equal(promptProblem(resumed), undefined);
  });
});

describe('meetAsk and meetPrompt', () => {
  it('send a session to its own cards on the owner, and only to them', () => {
    assert.equal(meetAsk('api', 'human'), 'human meets you now on your cards waiting on them: run `teamrig meet --cards --session api` and follow what it prints.');
    const prompt = meetPrompt('shop', 'api', 'human');
    assert.equal(prompt, `You are the api session of team shop. ${meetAsk('api', 'human')}`);
    assert.equal(promptProblem(prompt), undefined);
  });
});

describe('reopenPrompt', () => {
  it('tells a closed session, resumed, that its tasks may have moved', () => {
    const reopened = reopenPrompt('shop', 'api');
    assert.match(reopened, /^You are the api session of team shop, closed while idle to free the host and resumed in your last Claude Code session\. Your tasks may have moved since: run `teamrig inbox read` and `teamrig list --session api`/);
    assert.equal(promptProblem(reopened), undefined);
  });
});
