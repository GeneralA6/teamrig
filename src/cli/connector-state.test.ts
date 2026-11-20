import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative, sep } from 'node:path';
import { teamPaths } from '../core/home.ts';
import { connectorState } from './connector-state.ts';

const paths = teamPaths(join('kit', 'home'), 'crew', join('kit', 'claude'));

describe('connectorState', () => {
  it("puts a connector's state in its own folder under the team's state (T4766)", () => {
    const state = connectorState(paths, 'tracker');
    assert.equal(state.dir, join(paths.state, 'connectors', 'tracker'));
    assert.deepEqual(
      { ...state },
      {
        dir: state.dir,
        sync: join(state.dir, 'sync.json'),
        syncLock: join(state.dir, 'sync.lock'),
        ci: join(state.dir, 'ci'),
        pushHour: join(state.dir, 'push-hour.json'),
        clocks: join(state.dir, 'clocks.json'),
        watch: join(state.dir, 'watch.json'),
        watchLock: join(state.dir, 'watch.lock'),
        follows: join(state.dir, 'follows.json'),
        claims: join(state.dir, 'claims.json'),
      },
    );
  });

  it('gives each path its own name, so no two files of a connector are one', () => {
    const all = Object.values(connectorState(paths, 'tracker'));
    assert.equal(new Set(all).size, all.length);
  });

  it('shares no path between two connectors of a team, nor with a file the team already keeps', () => {
    const first = Object.values(connectorState(paths, 'tracker'));
    const second = Object.values(connectorState(paths, 'tracker-2'));
    const teamOwn = new Set(Object.values(paths));
    for (const path of [...first, ...second]) {
      assert.equal(teamOwn.has(path), false, path);
    }
    assert.deepEqual(
      first.filter((path) => second.includes(path)),
      [],
    );
  });

  it('follows a state folder the team moved in its config', () => {
    const moved = teamPaths(join('kit', 'home'), 'crew', join('kit', 'claude'), { state: join('elsewhere', 'state') });
    assert.equal(connectorState(moved, 'tracker').dir, join(moved.state, 'connectors', 'tracker'));
  });

  it('refuses an id that is no adapter id, so no id leaves the connectors folder or names one folder twice', () => {
    for (const id of ['', '..', '../tracker', 'a/b', 'a\\b', 'Tracker', 'tracker-', '-tracker', 'tracker_2', 'a b', '.']) {
      assert.throws(() => connectorState(paths, id), /no connector state for .*lower-case words joined by -/, id);
    }
  });

  it('keeps every path of an accepted id inside its own folder', () => {
    for (const id of ['tracker', 'code-host-2', 'a1']) {
      const state = connectorState(paths, id);
      for (const path of Object.values(state)) {
        assert.equal(relative(state.dir, path).split(sep).includes('..'), false, path);
      }
      assert.equal(relative(join(paths.state, 'connectors'), state.dir), id);
    }
  });
});
