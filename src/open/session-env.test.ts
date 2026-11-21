import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shippedPlugin } from '../testing/shipped-plugin.ts';
import { plainSessionEnv, sessionCredentialFree, sessionEnv } from './session-env.ts';

const IDENTITY = { id: 'api', team: 'shop', home: undefined };
const PLUGIN = shippedPlugin();
const SHIPPED_BIN = (folder: string): boolean => PLUGIN.isCacheBin(folder);

describe('sessionEnv', () => {
  it('sets the session and team, keeps the rest, and drops the opener session variables', () => {
    const env = sessionEnv(
      { PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_pid: '7', CLAUDE_EFFORT: 'high' },
      IDENTITY,
      'linux',
      SHIPPED_BIN,
    );
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_SESSION: 'api', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high', TEAMRIG_TEAM: 'shop' });
  });

  it('sets the kit home the opener used', () => {
    assert.deepEqual(sessionEnv({}, { ...IDENTITY, home: '/other/kit' }, 'linux', SHIPPED_BIN), { TEAMRIG_SESSION: 'api', TEAMRIG_TEAM: 'shop', TEAMRIG_HOME: '/other/kit' });
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
    const env = sessionEnv({ Path: path, PATHEXT: '.COM;.EXE' }, IDENTITY, 'win32', SHIPPED_BIN);
    assert.deepEqual(env, { Path: 'C:\\Program Files\\Git\\usr\\bin; C:\\Tools ;D:\\src\\teamrig\\plugins\\teamrig\\bin;', PATHEXT: '.COM;.EXE', TEAMRIG_SESSION: 'api', TEAMRIG_TEAM: 'shop' });
  });

  it('leaves them off a POSIX PATH, a moved configuration folder too, and reads PATH by its exact name there', () => {
    const env = sessionEnv(
      { PATH: '/home/me/.claude/plugins/cache/teamrig/teamrig/0.75.0/bin:/usr/bin:/srv/claude/plugins/cache/m/p/2.0.0/bin', Path: '/home/me/.claude/plugins/cache/m/p/1.0.0/bin' },
      IDENTITY,
      'darwin',
      SHIPPED_BIN,
    );
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['Path'], '/home/me/.claude/plugins/cache/m/p/1.0.0/bin', 'not PATH on macOS and Linux');
  });

  it("leaves off the folders the host's own test names, and keeps every folder for a host that has none", () => {
    const env = { PATH: '/opt/host/bins/p:/usr/bin:/home/me/.claude/plugins/cache/m/p/1.0.0/bin' };
    assert.equal(sessionEnv(env, IDENTITY, 'linux', (folder) => folder.startsWith('/opt/host/bins/'))['PATH'], '/usr/bin:/home/me/.claude/plugins/cache/m/p/1.0.0/bin');
    assert.equal(sessionEnv(env, IDENTITY, 'linux', () => false)['PATH'], env.PATH);
  });
});

describe('sessionCredentialFree', () => {
  it("keeps Claude Code's own login and the names passed on, and leaves the other credential variables out", () => {
    const value = 'not-a-real-credential';
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: value, CLAUDE_CODE_OAUTH_TOKEN: value, GH_TOKEN: value, NPM_TOKEN: value, OPENAI_API_KEY: value };
    assert.deepEqual(sessionCredentialFree(env, ['GH_TOKEN']), { PATH: '/bin', ANTHROPIC_API_KEY: value, CLAUDE_CODE_OAUTH_TOKEN: value, GH_TOKEN: value });
  });
});

describe('plainSessionEnv', () => {
  it('drops the opener Claude Code and teamrig session variables and keeps the rest', () => {
    const env = plainSessionEnv({ PATH: '/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_TEAM: 'shop', TEAMRIG_LAUNCHED: 'lead', TEAMRIG_HOME: '/kit', CLAUDECODE: '1', CLAUDE_EFFORT: 'high' }, undefined, 'linux', SHIPPED_BIN);
    assert.deepEqual(env, { PATH: '/bin', TEAMRIG_HOME: '/kit', CLAUDE_EFFORT: 'high' });
  });

  it('sets the kit home the restore used', () => {
    assert.deepEqual(plainSessionEnv({ TEAMRIG_HOME: '/kit' }, '/other/kit', 'linux', SHIPPED_BIN), { TEAMRIG_HOME: '/other/kit' });
  });

  it("leaves the opener's plugin bin folders off PATH, and sets none when there was none", () => {
    assert.deepEqual(plainSessionEnv({ PATH: '/opt/claude/plugins/cache/teamrig/teamrig/0.82.0/bin:/bin' }, undefined, 'linux', SHIPPED_BIN), { PATH: '/bin' });
    assert.deepEqual(plainSessionEnv({ HOME: '/home/me' }, undefined, 'win32', SHIPPED_BIN), { HOME: '/home/me' });
  });

  it('keeps every PATH folder for a host that keeps no plugin store', () => {
    const path = '/opt/claude/plugins/cache/teamrig/teamrig/0.82.0/bin:/bin';
    assert.deepEqual(plainSessionEnv({ PATH: path }, undefined, 'linux', () => false), { PATH: path });
  });
});
