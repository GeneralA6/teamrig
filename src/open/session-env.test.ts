import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { plainSessionEnv, sessionEnv } from './session-env.ts';

describe('sessionEnv', () => {
  it('sets the session and team, keeps the rest, and drops the opener session variables', () => {
    const env = sessionEnv(
      { PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_pid: '7', CLAUDE_EFFORT: 'high' },
      { id: 'api', team: 'shop', home: undefined },
    );
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_SESSION: 'api', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high', TEAMRIG_TEAM: 'shop' });
  });

  it('sets the kit home the opener used', () => {
    assert.deepEqual(sessionEnv({}, { id: 'api', team: 'shop', home: '/other/kit' }), { TEAMRIG_SESSION: 'api', TEAMRIG_TEAM: 'shop', TEAMRIG_HOME: '/other/kit' });
  });
});

describe('plainSessionEnv', () => {
  it('drops the opener Claude Code and teamrig session variables and keeps the rest', () => {
    const env = plainSessionEnv({ PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_TEAM: 'shop', TEAMRIG_LAUNCHED: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_EFFORT: 'high' }, undefined);
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high' });
  });

  it('sets the kit home the restore used', () => {
    assert.deepEqual(plainSessionEnv({ TEAMRIG_HOME: '/kit' }, '/other/kit'), { TEAMRIG_HOME: '/other/kit' });
  });
});
