import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import type { Checked } from '../setup/team-create.ts';
import { DEFAULTS_ITEM, planInstall, planUninstall, type AutoModePlan } from './install.ts';

const TAG = '[teamrig alpha] ';
const LINES = [`${TAG}one`, `${TAG}two`];
const OTHER_TEAM = '[teamrig beta] theirs';
const HAND = 'Source control: github.example/acme';

function planned(result: Checked<AutoModePlan>): AutoModePlan {
  assert.ok(result.ok, result.ok ? '' : result.problem);
  return result.value;
}

function problemOf(result: Checked<AutoModePlan>): string {
  assert.equal(result.ok, false);
  return result.ok ? '' : result.problem;
}

function withList(environment: readonly string[], others: JsonRecord = {}): JsonRecord {
  return { theme: 'dark', autoMode: { ...others, environment } };
}

describe('automode planInstall', () => {
  it("starts a machine with no list from Claude Code's built-in entries", () => {
    const plan = planned(planInstall({ theme: 'dark' }, TAG, LINES));
    assert.deepEqual(plan, {
      settings: { theme: 'dark', autoMode: { environment: [DEFAULTS_ITEM, ...LINES] } },
      removed: [],
      added: [DEFAULTS_ITEM, ...LINES],
    });
  });

  it('keeps the other autoMode keys when there is no list yet', () => {
    const plan = planned(planInstall({ autoMode: { soft_deny: ['x'] } }, TAG, LINES));
    assert.deepEqual(plan.settings, { autoMode: { soft_deny: ['x'], environment: [DEFAULTS_ITEM, ...LINES] } });
  });

  it("appends to a list with none of the team's lines, without adding $defaults to it", () => {
    const plan = planned(planInstall(withList([HAND, OTHER_TEAM], { hard_deny: ['y'] }), TAG, LINES));
    assert.deepEqual(plan, { settings: withList([HAND, OTHER_TEAM, ...LINES], { hard_deny: ['y'] }), removed: [], added: LINES });
  });

  it("replaces the team's lines at the first one's place, leaving hand lines and other teams' lines alone", () => {
    const plan = planned(planInstall(withList([DEFAULTS_ITEM, `${TAG}old`, HAND, `${TAG}two`, OTHER_TEAM]), TAG, LINES));
    assert.deepEqual(plan, { settings: withList([DEFAULTS_ITEM, ...LINES, HAND, OTHER_TEAM]), removed: [`${TAG}old`], added: [`${TAG}one`] });
  });

  it('changes nothing when the lines are already in, in order', () => {
    assert.deepEqual(planned(planInstall(withList([HAND, ...LINES, OTHER_TEAM]), TAG, LINES)), { settings: undefined, removed: [], added: [] });
  });

  it('refuses an autoMode or a list it cannot read', () => {
    assert.match(problemOf(planInstall({ autoMode: 'on' }, TAG, LINES)), /^autoMode is not an object/);
    assert.match(problemOf(planInstall({ autoMode: { environment: 'x' } }, TAG, LINES)), /^autoMode\.environment is not a list of strings/);
    assert.match(problemOf(planInstall({ autoMode: { environment: [HAND, 3] } }, TAG, LINES)), /^autoMode\.environment is not a list of strings/);
  });
});

describe('automode planUninstall', () => {
  it("takes the team's lines out, leaving hand lines and other teams' lines", () => {
    const plan = planned(planUninstall(withList([DEFAULTS_ITEM, ...LINES, HAND, OTHER_TEAM]), TAG));
    assert.deepEqual(plan, { settings: withList([DEFAULTS_ITEM, HAND, OTHER_TEAM]), removed: LINES, added: [] });
  });

  it('drops a list left as only $defaults, and an autoMode left empty', () => {
    const plan = planned(planUninstall(withList([DEFAULTS_ITEM, ...LINES]), TAG));
    assert.deepEqual(plan.settings, { theme: 'dark' });
  });

  it('keeps the other autoMode keys when the list is dropped', () => {
    const plan = planned(planUninstall(withList([DEFAULTS_ITEM, ...LINES], { soft_deny: ['x'] }), TAG));
    assert.deepEqual(plan.settings, { theme: 'dark', autoMode: { soft_deny: ['x'] } });
  });

  it("keeps an empty list, which turns Claude Code's built-in entries off, as the person had it", () => {
    const plan = planned(planUninstall(withList(LINES), TAG));
    assert.deepEqual(plan.settings, withList([]));
  });

  it("changes nothing without the team's lines or without a list", () => {
    const none = { settings: undefined, removed: [], added: [] };
    assert.deepEqual(planned(planUninstall(withList([HAND, OTHER_TEAM]), TAG)), none);
    assert.deepEqual(planned(planUninstall({ autoMode: { soft_deny: ['x'] } }, TAG)), none);
    assert.deepEqual(planned(planUninstall({}, TAG)), none);
  });

  it('refuses an autoMode or a list it cannot read', () => {
    assert.match(problemOf(planUninstall({ autoMode: [] }, TAG)), /^autoMode is not an object/);
    assert.match(problemOf(planUninstall({ autoMode: { environment: {} } }, TAG)), /^autoMode\.environment is not a list of strings/);
  });
});
