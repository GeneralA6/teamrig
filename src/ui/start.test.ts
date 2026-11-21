import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { releasedEnv, UI_ENV, uiRequest } from './start.ts';

describe('releasedEnv', () => {
  it('keeps the paths, terminal, locale and the teamrig variables the CLI reads, in any case, and drops the rest', () => {
    const env = {
      Path: 'C:\\bin',
      HOME: '/var/h',
      USERPROFILE: 'D:\\profile',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LANGUAGE: 'en',
      LC_ALL: 'C',
      TEAMRIG_HOME: '/kit',
      TEAMRIG_TEAM: 'app',
      teamrig_session: 'alpha',
      TEAMRIG_X_TOKEN: 'secret',
      TEAMRIG_HOST_LOCK: 'lock',
      GH_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      NODE_OPTIONS: '--require /x.js',
      PATHEXT: '.EXE',
      HOMEDRIVE: 'C:',
      UNSET: undefined,
    };
    assert.deepEqual(releasedEnv(env), {
      Path: 'C:\\bin',
      HOME: '/var/h',
      USERPROFILE: 'D:\\profile',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LANGUAGE: 'en',
      LC_ALL: 'C',
      TEAMRIG_HOME: '/kit',
      TEAMRIG_TEAM: 'app',
      teamrig_session: 'alpha',
    });
  });
});

const START = { entry: '/pane/out/ui/main.js', node: '/bin/node', script: '/kit/dist/cli/main.js', team: 'app', cwd: '/work/app', env: { PATH: '/bin' } };

describe('uiRequest', () => {
  it('runs the entry under this CLI’s node for the team, in the caller’s folder', () => {
    const request = uiRequest(START);
    assert.equal(request.command, '/bin/node');
    assert.deepEqual(request.args, ['/pane/out/ui/main.js', '--team', 'app']);
    assert.equal(request.cwd, '/work/app');
  });

  it('names the session only when one is given', () => {
    assert.deepEqual(uiRequest({ ...START, session: 'alpha' }).args, ['/pane/out/ui/main.js', '--team', 'app', '--session', 'alpha']);
  });

  it('keeps the caller’s environment and adds the CLI the UI calls back, over a value already there', () => {
    const request = uiRequest({ ...START, env: { PATH: '/bin', [UI_ENV.cli]: '/old/main.js' } });
    assert.deepEqual(request.env, { PATH: '/bin', TEAMRIG_CLI: '/kit/dist/cli/main.js', TEAMRIG_NODE: '/bin/node' });
  });
});
