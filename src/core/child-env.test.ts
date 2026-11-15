import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLAUDE_LOGIN_VARIABLES, CREDENTIAL_VARIABLES, withoutCredentials } from './child-env.ts';

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
