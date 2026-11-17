import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAUDE_LOGIN_VARIABLES,
  CLAUDE_SESSION_VARIABLES,
  CREDENTIAL_VARIABLES,
  dispatchedEnvOf,
  heldBackCredentials,
  PARKED_SESSION_VARIABLES,
  PARKED_VARIABLES,
  parkedEnvOf,
  withoutCredentials,
  withoutListedCredentials,
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

  it('leaves out a credential the list does not name, by the ending of its name', () => {
    const named = {
      GITHUB_PACKAGE_TOKEN: VALUE,
      CLAUDE_CODE_MESSAGING_TOKEN: VALUE,
      npm_config__authToken: VALUE,
      DB_PASSWORD: VALUE,
      PGPASSWD: VALUE,
      SENTRY_API_KEY: VALUE,
      MAPS_APIKEY: VALUE,
      DEPLOY_PRIVATE_KEY: VALUE,
      AZURE_STORAGE_ACCESS_KEY: VALUE,
      JWT_SECRET: VALUE,
      GOOGLE_APPLICATION_CREDENTIALS: VALUE,
    };
    assert.deepEqual(withoutCredentials({ ...named, PATH: '/usr/bin' }, []), { PATH: '/usr/bin' });
  });

  it('keeps a name that only holds a credential word inside it or past its end', () => {
    const kept = {
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '25000',
      TOKENIZERS_PARALLELISM: 'false',
      KEYBOARD_LAYOUT: 'us',
      SECRETS_DIR: '/run/secrets',
      PASSWORD_STORE_DIR: '/store',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    };
    assert.deepEqual(withoutCredentials(kept, []), kept);
  });

  it('keeps a credential named by its ending that pass names', () => {
    assert.deepEqual(withoutCredentials({ GITHUB_PACKAGE_TOKEN: VALUE, DB_PASSWORD: VALUE }, ['github_package_token']), {
      GITHUB_PACKAGE_TOKEN: VALUE,
    });
  });
});

describe('withoutListedCredentials', () => {
  it('leaves out only the listed credentials, keeping a key of the user under another name for a session', () => {
    assert.deepEqual(withoutListedCredentials({ GH_TOKEN: VALUE, SENTRY_API_KEY: VALUE, PATH: '/usr/bin' }, []), {
      SENTRY_API_KEY: VALUE,
      PATH: '/usr/bin',
    });
  });

  it('keeps the listed credentials pass names, in any case', () => {
    assert.deepEqual(withoutListedCredentials({ ANTHROPIC_API_KEY: VALUE, GH_TOKEN: VALUE }, ['anthropic_api_key']), {
      ANTHROPIC_API_KEY: VALUE,
    });
  });
});

describe('heldBackCredentials', () => {
  it('names the variables a program does not get, sorted, and none that pass keeps', () => {
    const env = { PATH: '/usr/bin', NPM_TOKEN: VALUE, DB_PASSWORD: VALUE, GITHUB_PACKAGE_TOKEN: VALUE };
    assert.deepEqual(heldBackCredentials(env, ['db_password']), ['GITHUB_PACKAGE_TOKEN', 'NPM_TOKEN']);
  });

  it('names none when the environment holds no credential', () => {
    assert.deepEqual(heldBackCredentials({ PATH: '/usr/bin' }, []), []);
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
