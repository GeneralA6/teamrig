import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import { branchTaskOf, removalRefusal, type WorktreeRemover } from './owner.ts';

/** The lead over sub-lead `web`, who leads `ui`; `api` answers to the lead. */
const TREE = new LeadTree({ sessions: ['lead', 'web', 'ui', 'api'], roles: { lead: 'lead' }, leads: { web: ['ui'] } });
const OWNERS: ReadonlyMap<string, string> = new Map([
  ['T4', 'ui'],
  ['T5', 'api'],
  ['T6', 'lead'],
]);

function refusal(caller: string, branch: string | undefined, mergedInto?: string): string | undefined {
  const remover: WorktreeRemover = { caller, branch, mergedInto, ownerOf: (task) => OWNERS.get(task), tree: TREE };
  return removalRefusal(remover);
}

describe('branchTaskOf', () => {
  it('reads the task a branch is named for', () => {
    assert.equal(branchTaskOf('t4-parser'), 'T4');
    assert.equal(branchTaskOf('T1319-worktree-owners'), 'T1319');
    assert.equal(branchTaskOf('t12'), 'T12');
  });

  it('finds none in a branch named for no task', () => {
    assert.equal(branchTaskOf('main'), undefined);
    assert.equal(branchTaskOf('tools-t4'), undefined);
    assert.equal(branchTaskOf('t4parser'), undefined);
    assert.equal(branchTaskOf(undefined), undefined);
  });
});

describe('removalRefusal', () => {
  it("lets a session remove the worktree of a task it owns", () => {
    assert.equal(refusal('ui', 't4-parser'), undefined);
    assert.equal(refusal('api', 't5-routes'), undefined);
  });

  it('lets each leader above the owner remove it, the lead any worktree', () => {
    assert.equal(refusal('web', 't4-parser'), undefined);
    assert.equal(refusal('lead', 't4-parser'), undefined);
    assert.equal(refusal('lead', 'scratch'), undefined);
    assert.equal(refusal('lead', undefined), undefined);
  });

  it("refuses another session's worktree, naming who may remove it", () => {
    assert.equal(refusal('api', 't4-parser'), "the worktree's branch t4-parser is T4's, which ui owns: only ui or web or lead removes it");
    assert.equal(refusal('web', 't5-routes'), "the worktree's branch t5-routes is T5's, which api owns: only api or lead removes it");
    assert.equal(refusal('ui', 't6-plan'), "the worktree's branch t6-plan is T6's, which lead owns: only lead removes it");
  });

  it('leaves a worktree whose branch names no task on the register to the lead', () => {
    assert.equal(refusal('ui', 'scratch'), "the worktree's branch scratch names no task (t<id>-<name>), so only the lead (lead) removes it");
    assert.equal(refusal('ui', 't9-gone'), "the worktree's branch t9-gone names T9, which the register lacks, so only the lead (lead) removes it");
    assert.equal(
      refusal('ui', undefined),
      'the worktree is on no branch, and git does not show every commit of its HEAD on the default branch (as of the last fetch), so only the lead (lead) removes it: if it merged, fetch and run this again',
    );
  });

  it('lets any session remove a worktree on a detached HEAD the default branch holds, as teamrig merge leaves it (T1856)', () => {
    assert.equal(refusal('ui', undefined, 'origin/main'), undefined);
    assert.equal(refusal('api', undefined, 'origin/main'), undefined);
  });

  it('still asks the branch owner for a worktree on a branch, whatever the default branch holds', () => {
    assert.equal(refusal('api', 't4-parser', 'origin/main'), "the worktree's branch t4-parser is T4's, which ui owns: only ui or web or lead removes it");
  });

  it('names the lead for an owner off the team', () => {
    const remover: WorktreeRemover = { caller: 'ui', branch: 't7-x', mergedInto: undefined, ownerOf: () => 'outsider', tree: TREE };
    assert.equal(removalRefusal(remover), "the worktree's branch t7-x is T7's, which outsider owns: only outsider or lead removes it");
  });
});
