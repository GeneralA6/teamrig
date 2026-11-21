import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UI_ENV, uiRequest } from './start.ts';

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
