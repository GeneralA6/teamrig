import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The team-setup skill's order held to what the setup needs: it backs the user's Claude setup up and scans it before
 * `team create` changes anything, names the restore that undoes the slimming, and each "step N" it points to is the
 * step that does that job, so a step added or moved cannot leave a mention pointing at the wrong one.
 */

const SKILL = readFileSync(fileURLToPath(new URL('../../plugins/teamrig/skills/team-setup/SKILL.md', import.meta.url)), 'utf8');
const STEP_HEADING = /^## (\d+)\. (.+)$/gm;

/** The number of the step whose heading starts with `title`. */
function stepOf(title: string): number {
  const step = [...SKILL.matchAll(STEP_HEADING)].find((heading) => heading[2]?.startsWith(title));
  assert.ok(step?.[1] !== undefined, `no step titled "${title}"`);
  return Number(step[1]);
}

/** Where `text` first stands in the skill; fails when it is not there. */
function positionOf(text: string): number {
  const at = SKILL.indexOf(text);
  assert.ok(at >= 0, `the skill does not name ${text}`);
  return at;
}

/** The text of the step whose heading starts with `title`, up to the next step's heading. */
function stepTextOf(title: string): string {
  const start = positionOf(`## ${stepOf(title)}. ${title}`);
  const next = SKILL.indexOf('\n## ', start + 1);
  return SKILL.slice(start, next < 0 ? SKILL.length : next);
}

describe('the team-setup skill', () => {
  it('backs the Claude setup up, then scans it, before the team is created', () => {
    const backup = positionOf('teamrig setup backup --project');
    const scan = positionOf('teamrig setup scan --project');
    const create = positionOf('teamrig team create <team>');
    assert.ok(backup < scan && scan < create, 'backup, then scan, then team create');
    assert.ok(stepOf('Back up the Claude setup') < stepOf('Create the team'));
  });

  it('names the restore that undoes the slimming, and the scan again for before and after', () => {
    const slimming = SKILL.slice(positionOf('## 3. Back up the Claude setup'), positionOf('## 4. Create the team'));
    assert.match(slimming, /`teamrig setup restore <stamp>` shows what undoing it writes/);
    assert.match(slimming, /Run `teamrig setup scan --project "<project>"` again/);
    assert.match(slimming, /one yes or no per group/);
  });

  it('leaves the permissions trim to the user, after the team exists', () => {
    assert.ok(positionOf('`! teamrig permissions trim --yes`') > positionOf('teamrig team create <team>'));
  });

  it('points each step mention at the step that does that job', () => {
    const create = stepOf('Create the team');
    assert.ok(SKILL.includes(`You close it in step ${stepOf('Close the setup task')}.`));
    assert.ok(SKILL.includes(`the id from step ${create} and the first tasks of step ${stepOf('Give each session')}:`));
    assert.ok(SKILL.includes(`go on to step ${create}.`));
    assert.ok(SKILL.includes(`step ${stepOf('Settle the local rules')} settles those rule lines`));
    assert.ok(SKILL.includes(`Step ${stepOf('Back up the Claude setup')}'s scan had a \`SETTINGS\` finding`));
    assert.ok(SKILL.includes(`its root teams (step ${stepOf('Checkpoint')}),`));
  });

  it('has the checkpoint split the week by plans, from the main lead down, with the floor and appeals', () => {
    const checkpoint = stepTextOf('Checkpoint');
    for (const text of ['`[budget.accountLead]`', '`[budget.shareFloorPct]`%', 'A team past its share opens nothing new', '`Appeal: ...`', 'It never blocks']) {
      assert.ok(checkpoint.includes(text), `the checkpoint does not name ${text}`);
    }
  });

  it('asks for the main lead when a second root team joins the account', () => {
    assert.match(stepTextOf('Turn on the daily budget'), /`"accountLead": "<team>"` under `budget` in every root team's `config\.json` on the\saccount/);
  });
});
