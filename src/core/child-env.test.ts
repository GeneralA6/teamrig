import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_LOGIN_VARIABLES,
  CLAUDE_SESSION_VARIABLES,
  CREDENTIAL_VARIABLES,
  dispatchedEnvOf,
  PARKED_SESSION_VARIABLES,
  PARKED_VARIABLES,
  parkedEnvOf,
  withoutCredentials,
} from './child-env.ts';

const VALUE = 'not-a-real-credential';

describe('withoutCredentials', () => {
  it('leaves every credential variable out and keeps the rest as they were', () => {
    const credentials = Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, VALUE]));
    assert.deepEqual(withoutCredentials({ ...credentials, PATH: '/usr/bin', TERM: 'xterm', NPM_CONFIG_CACHE: '/cache' }, []), {
      PATH: '/usr/bin',
      TERM: 'xterm',
      NPM_CONFIG_CACHE: '/cache',
    });
  });

  it('compares names without case, as Windows reads them', () => {
    assert.deepEqual(withoutCredentials({ gh_token: VALUE, Github_Token: VALUE, Path: 'C:/Windows' }, []), { Path: 'C:/Windows' });
  });

  it('keeps the credential variables pass names, in any case', () => {
    assert.deepEqual(withoutCredentials({ NPM_TOKEN: VALUE, GH_TOKEN: VALUE, PATH: '/usr/bin' }, ['npm_token']), { NPM_TOKEN: VALUE, PATH: '/usr/bin' });
  });

  it("lists Claude Code's own login among the credentials", () => {
    assert.ok(CLAUDE_LOGIN_VARIABLES.every((name) => CREDENTIAL_VARIABLES.includes(name)));
  });
});

describe('parkedEnvOf (T4093)', () => {
  it('keeps only the allow-listed and teamrig variables, in any case, so an unknown secret never reaches disk', () => {
    const credentials = Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, VALUE]));
    const env = { ...credentials, Path: 'C:/Windows', TEMP: 'C:/Temp', TEAMRIG_SESSION: 'alpha', teamrig_team: 'kit', MY_DB_PASSWORD: VALUE, NPM_CONFIG__AUTHTOKEN: VALUE, GIT_CONFIG_PARAMETERS: VALUE };
    assert.deepEqual(parkedEnvOf(env), { Path: 'C:/Windows', TEMP: 'C:/Temp', TEAMRIG_SESSION: 'alpha', teamrig_team: 'kit' });
  });

  it('lists no credential variable', () => {
    assert.ok(PARKED_VARIABLES.every((name) => !CREDENTIAL_VARIABLES.includes(name)));
  });
});

describe('dispatchedEnvOf (T4093)', () => {
  it("runs a step with the dispatcher's environment under its parked variables, credentials kept", () => {
    const dispatcher = { PATH: '/dispatcher/bin', GH_TOKEN: VALUE, JAVA_HOME: '/jdk' };
    assert.deepEqual(dispatchedEnvOf(dispatcher, { PATH: '/step/bin', TEAMRIG_SESSION: 'alpha' }), { PATH: '/step/bin', GH_TOKEN: VALUE, JAVA_HOME: '/jdk', TEAMRIG_SESSION: 'alpha' });
  });

  it("never gives a step the dispatcher's teamrig variables, nor a second copy of a name in another case", () => {
    const dispatcher = { TEAMRIG_SESSION: 'beta', TEAMRIG_HOST_LOCK: 'lock-1', Path: '/dispatcher/bin' };
    assert.deepEqual(dispatchedEnvOf(dispatcher, { PATH: '/step/bin' }), { PATH: '/step/bin' });
  });

  it("runs a step as its parker's Claude Code session, never the dispatcher's, and without a messaging token", () => {
    const sessionOf = (id: string): Record<string, string> =>
      Object.fromEntries(CLAUDE_SESSION_VARIABLES.map((name) => [name, name === 'CLAUDE_CODE_MESSAGING_TOKEN' ? VALUE : `${id}-${name}`]));
    const dispatcher = { ...sessionOf('a'), PATH: '/dispatcher/bin' };
    const parker = { ...sessionOf('b'), PATH: '/step/bin' };
    assert.deepEqual(dispatchedEnvOf(dispatcher, parkedEnvOf(parker)), {
      PATH: '/step/bin',
      CLAUDECODE: 'b-CLAUDECODE',
      CLAUDE_CODE_SESSION_ID: 'b-CLAUDE_CODE_SESSION_ID',
      CLAUDE_CODE_ENTRYPOINT: 'b-CLAUDE_CODE_ENTRYPOINT',
      CLAUDE_PROJECT_DIR: 'b-CLAUDE_PROJECT_DIR',
    });
  });

  it('keeps only session variables that are no secret on disk', () => {
    assert.ok(PARKED_SESSION_VARIABLES.every((name) => CLAUDE_SESSION_VARIABLES.includes(name)));
    assert.ok(!PARKED_SESSION_VARIABLES.includes('CLAUDE_CODE_MESSAGING_TOKEN'));
  });
});
