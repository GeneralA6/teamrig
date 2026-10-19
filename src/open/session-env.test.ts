import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { plainSessionEnv, sessionEnv } from './session-env.ts';

const IDENTITY = { id: 'api', team: 'shop', home: undefined };

describe('sessionEnv', () => {
  it('sets the session and team, keeps the rest, and drops the opener session variables', () => {
    const env = sessionEnv(
      { PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_pid: '7', CLAUDE_EFFORT: 'high' },
      IDENTITY,
      'linux',
    );
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_SESSION: 'api', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high', TEAMRIG_TEAM: 'shop' });
  });

  it('sets the kit home the opener used', () => {
    assert.deepEqual(sessionEnv({}, { ...IDENTITY, home: '/other/kit' }, 'linux'), { TEAMRIG_SESSION: 'api', TEAMRIG_TEAM: 'shop', TEAMRIG_HOME: '/other/kit' });
  });

  it("leaves the opener's Claude Code plugin bin folders off a Windows Path, under its own name, and keeps the rest as written", () => {
    const path = [
      'C:\\Program Files\\Git\\usr\\bin',
      'C:\\Users\\me\\.claude\\plugins\\cache\\teamrig\\teamrig\\0.75.0\\bin',
      '"C:\\Users\\me\\.claude\\plugins\\cache\\tools\\lint\\1.2.0\\bin\\"',
      ' C:\\Tools ',
      'D:\\src\\teamrig\\plugins\\teamrig\\bin',
      '',
    ].join(';');
    const env = sessionEnv({ Path: path, PATHEXT: '.COM;.EXE' }, IDENTITY, 'win32');
    assert.deepEqual(env, { Path: 'C:\\Program Files\\Git\\usr\\bin; C:\\Tools ;D:\\src\\teamrig\\plugins\\teamrig\\bin;', PATHEXT: '.COM;.EXE', TEAMRIG_SESSION: 'api', TEAMRIG_TEAM: 'shop' });
  });

  it('leaves them off a POSIX PATH, a moved configuration folder too, and reads PATH by its exact name there', () => {
    const env = sessionEnv(
      { PATH: '/home/me/.claude/plugins/cache/teamrig/teamrig/0.75.0/bin:/usr/bin:/srv/claude/plugins/cache/m/p/2.0.0/bin', Path: '/home/me/.claude/plugins/cache/m/p/1.0.0/bin' },
      IDENTITY,
      'darwin',
    );
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['Path'], '/home/me/.claude/plugins/cache/m/p/1.0.0/bin', 'not PATH on macOS and Linux');
  });
});

describe('plainSessionEnv', () => {
  it('drops the opener Claude Code and teamrig session variables and keeps the rest', () => {
    const env = plainSessionEnv({ PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_TEAM: 'shop', TEAMRIG_LAUNCHED: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_EFFORT: 'high' }, undefined, 'linux');
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high' });
  });

  it('sets the kit home the restore used', () => {
    assert.deepEqual(plainSessionEnv({ TEAMRIG_HOME: '/kit' }, '/other/kit', 'linux'), { TEAMRIG_HOME: '/other/kit' });
  });

  it("leaves the opener's plugin bin folders off PATH, and sets none when there was none", () => {
    assert.deepEqual(plainSessionEnv({ PATH: '/opt/claude/plugins/cache/teamrig/teamrig/0.82.0/bin:/bin' }, undefined, 'linux'), { PATH: '/bin' });
    assert.deepEqual(plainSessionEnv({ HOME: '/home/me' }, undefined, 'win32'), { HOME: '/home/me' });
  });
});
