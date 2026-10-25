import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamTree, type TeamNode } from '../config/tree.ts';
import { reachOf, type Reach } from './reach.ts';

function team(id: string, parent?: string): TeamNode {
  return { team: id, statedId: id, parent, lead: 'lead', sessions: ['lead', 'dev'], names: new Map() };
}

/** `app` is a root; `web` and `ops` are its children; `ui` is under `web`. `shop` is the root of a separate tree. */
const TREE = new TeamTree([team('app'), team('web', 'app'), team('ops', 'app'), team('ui', 'web'), team('shop')]);

function reach(from: string, to: string): Reach {
  const [fromTeam = '', fromId = ''] = from.split('/');
  const [toTeam = '', toId = ''] = to.split('/');
  return reachOf(TREE, { team: fromTeam, id: fromId }, { team: toTeam, id: toId });
}

function problemOf(verdict: Reach): string {
  assert.ok(!verdict.ok, 'expected a refusal');
  return verdict.problem;
}

describe('reachOf', () => {
  it('lets anyone reach their own team', () => {
    assert.deepEqual(reach('web/dev', 'web/lead'), { ok: true });
    assert.deepEqual(reach('web/lead', 'web/dev'), { ok: true });
    assert.deepEqual(reach('shop/dev', 'shop/lead'), { ok: true });
  });

  it('lets any session reach any session of its tree: up, down, across sibling teams and past a level', () => {
    assert.deepEqual(reach('web/dev', 'app/lead'), { ok: true });
    assert.deepEqual(reach('app/lead', 'ui/dev'), { ok: true });
    assert.deepEqual(reach('web/dev', 'ops/dev'), { ok: true });
    assert.deepEqual(reach('ui/dev', 'ops/lead'), { ok: true });
  });

  it('refuses a session of a separate tree, either way', () => {
    assert.equal(problemOf(reach('app/lead', 'shop/lead')), 'app/lead and shop/lead are in separate trees of teams: an inbox line reaches only a session of its own tree');
    assert.match(problemOf(reach('shop/dev', 'ui/dev')), /^shop\/dev and ui\/dev are in separate trees/);
  });

  it('refuses a sender whose team is not in the tree', () => {
    assert.match(problemOf(reach('gone/dev', 'app/lead')), /^gone\/dev and app\/lead are in separate trees/);
  });
});
