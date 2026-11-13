import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { CliHarness } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, teamHomeOf, treeHarness } from '../testing/team-tree.ts';
import { dayScheduleStoreOf, dayStartFor } from './day-schedule.ts';
import { openKit } from './kit.ts';
import type { LoadedTeam } from './root-team.ts';

const NOON = Date.UTC(2030, 0, 8, 12, 0);
const EIGHT = Date.UTC(2030, 0, 8, 8, 0);
const SCHEDULE = join(teamHomeOf('app'), 'state', 'day-schedule.json');

/** The tree with team `web` starting its day at 08:00 UTC by its own config. */
async function webAtEight(): Promise<CliHarness> {
  const kit = await treeHarness();
  await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS.web, wake: { dayStartUtc: '08:00' } }));
  return kit;
}

async function loadedTeam(kit: CliHarness, team: string): Promise<LoadedTeam> {
  const opened = await openKit(kit.runtime(), team);
  assert.equal(opened.load.status, 'loaded');
  if (opened.load.status !== 'loaded') {
    throw new Error(`${team} did not load`);
  }
  return { kit: opened, config: opened.load.config };
}

describe('dayScheduleStoreOf', () => {
  it('is undefined when a config up the tree does not load', async () => {
    const kit = await webAtEight();
    const web = await loadedTeam(kit, 'web');
    await kit.files.write(teamConfigOf('app'), '{ not json');
    assert.equal(await dayScheduleStoreOf(kit.runtime(), web), undefined);
  });
});

describe('dayStartFor', () => {
  it("falls back to the team's wake.dayStartUtc when the root's config does not load", async () => {
    const kit = await webAtEight();
    const web = await loadedTeam(kit, 'web');
    await kit.files.write(teamConfigOf('app'), '{ not json');
    assert.deepEqual(await dayStartFor(kit.runtime(), web, 'front', NOON), { at: EIGHT, next: EIGHT + 86_400_000, source: 'config' });
  });

  it("falls back to the team's wake.dayStartUtc when the schedule file cannot be read as one", async () => {
    const kit = await webAtEight();
    await kit.files.write(SCHEDULE, 'garbage\n');
    const web = await loadedTeam(kit, 'web');
    assert.deepEqual(await dayStartFor(kit.runtime(), web, 'front', NOON), { at: EIGHT, next: EIGHT + 86_400_000, source: 'config' });
  });

  it("takes the session's own entry over its team's and the config", async () => {
    const kit = await webAtEight();
    await kit.files.write(SCHEDULE, `${JSON.stringify({ v: 1, days: { '2030-01-08': { web: '09:00', 'web/front': '10:00' } } })}\n`);
    const web = await loadedTeam(kit, 'web');
    const front = await dayStartFor(kit.runtime(), web, 'front', NOON);
    assert.deepEqual(front, { at: Date.UTC(2030, 0, 8, 10, 0), next: Date.UTC(2030, 0, 9, 10, 0), source: 'schedule' });
    const back = await dayStartFor(kit.runtime(), web, 'back', NOON);
    assert.equal(back.at, Date.UTC(2030, 0, 8, 9, 0));
  });
});
