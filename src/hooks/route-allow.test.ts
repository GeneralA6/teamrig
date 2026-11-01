import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS } from '../config/defaults.ts';
import { SANCTIONED_ROUTES, type RouteId, type SanctionedRoute } from '../permissions/sanctioned.ts';
import { guardsPassed, preToolUseRouteOf, routeAllowOn, routeAllowOutput, routeAllowRecord } from './route-allow.ts';

function routeOf(id: RouteId): SanctionedRoute {
  const found = SANCTIONED_ROUTES.find((route) => route.id === id);
  assert.ok(found, id);
  return found;
}

describe('route allow', () => {
  it('answers only while the team refuses asks and its switch is on', () => {
    assert.equal(routeAllowOn(DEFAULT_PROMPTS), false);
    assert.equal(routeAllowOn({ hookAsks: 'refuse', routeAllow: 'on' }), true);
    assert.equal(routeAllowOn({ hookAsks: 'refuse', routeAllow: 'off' }), false);
    assert.equal(routeAllowOn({ hookAsks: 'ask', routeAllow: 'on' }), false);
  });

  it('takes the routes the owner granted or that stay local, never a push or the register', () => {
    const allowed = SANCTIONED_ROUTES.filter((route) => preToolUseRouteOf(route) !== undefined).map((route) => route.id);
    assert.deepEqual(allowed, ['merge', 'deploy', 'exec-request', 'worktree-remove', 'git-commit']);
    assert.equal(preToolUseRouteOf(undefined), undefined);
  });

  it('passes only when no guard asked or refused', () => {
    assert.equal(guardsPassed([]), true);
    assert.equal(guardsPassed(['', '']), true);
    assert.equal(guardsPassed(['', '{"hookSpecificOutput":{}}']), false);
  });

  it('prints a PreToolUse allow naming the route and what it is for', () => {
    const merge = routeOf('merge');
    assert.deepEqual(JSON.parse(routeAllowOutput(merge)), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `teamrig: the sanctioned route merge, to ${merge.purpose}`,
      },
    });
  });

  it('logs the route, the sessions and the time, never the command', () => {
    const at = new Date('2030-01-08T10:00:00.000Z');
    assert.deepEqual(routeAllowRecord({ at, session: 'alpha', claudeSession: 'c1', route: 'git-commit' }), {
      v: 1,
      at: '2030-01-08T10:00:00.000Z',
      session: 'alpha',
      claudeSession: 'c1',
      tool: 'Bash',
      event: 'PreToolUse',
      answer: 'route',
      route: 'git-commit',
      command: null,
    });
    assert.equal(routeAllowRecord({ at, session: undefined, claudeSession: null, route: 'merge' })['session'], null);
  });
});
