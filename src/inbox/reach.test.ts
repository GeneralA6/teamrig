import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamTree, type TeamNode } from '../config/tree.ts';
import { reachOf, type Reach } from './reach.ts';

function team(id: string, parent?: string): TeamNode {
  return { team: id, statedId: id, parent, lead: 'lead', sessions: ['lead', 'dev'], names: new Map() };
}

/** `app` is the root; `web` and `ops` are its children; `ui` is under `web`. */
const TREE = new TeamTree([team('app'), team('web', 'app'), team('ops', 'app'), team('ui', 'web')]);

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
  });

  it('lets a lead reach its parent lead and its child leads, and nobody else', () => {
    assert.deepEqual(reach('web/lead', 'app/lead'), { ok: true });
    assert.deepEqual(reach('web/lead', 'ui/lead'), { ok: true });
    assert.deepEqual(reach('app/lead', 'web/lead'), { ok: true });
    assert.match(problemOf(reach('app/lead', 'ui/lead')), /^app\/lead may write to its own team, its parent team's lead and its child teams' leads, and ui\/lead is none of them: escalate through your lead/);
    assert.match(problemOf(reach('web/lead', 'ops/lead')), /ops\/lead is none of them/);
    assert.match(problemOf(reach('app/lead', 'web/dev')), /web\/dev is none of them/);
  });

  it('keeps a member to its own team, pointing at its lead', () => {
    assert.equal(problemOf(reach('web/dev', 'app/lead')), 'web/dev may write to its own team only, and app/lead is not on it: escalate through your lead (web/lead)');
    assert.match(problemOf(reach('web/dev', 'ui/lead')), /escalate through your lead \(web\/lead\)$/);
  });

  it('refuses a sender whose team is not in the tree, without naming a lead', () => {
    assert.equal(problemOf(reach('gone/dev', 'app/lead')), 'gone/dev may write to its own team only, and app/lead is not on it: escalate through your lead');
  });
});
