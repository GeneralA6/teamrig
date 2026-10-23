import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { JsonRecord } from '../core/guards.ts';
import { CliHarness, KIT, TEAM } from './cli-harness.ts';

/** A team's folder under the harness's kit home. */
export function teamHomeOf(team: string): string {
  return join(KIT, 'teams', team);
}

export function teamConfigOf(team: string): string {
  return join(teamHomeOf(team), 'config.json');
}

export function teamEventsOf(team: string): string {
  return join(teamHomeOf(team), 'state', 'events.jsonl');
}

export function teamInboxOf(team: string, id: string): string {
  return join(teamHomeOf(team), 'state', 'inbox', `${id}.md`);
}

/**
 * The sub-teams of the harness's team `app`, which is the root: `web` and `ops` under it, `ui` under
 * `web`. Each is led by `lead`; sessions take their default names, `<team>-<id>`.
 */
export const SUB_TEAMS: Readonly<Record<string, JsonRecord>> = {
  web: { configVersion: 1, team: { id: 'web', parent: 'app' }, sessions: ['lead', 'front', 'back'], roles: { lead: 'lead' } },
  ops: { configVersion: 1, team: { id: 'ops', parent: 'app' }, sessions: ['lead', 'run'], roles: { lead: 'lead' } },
  ui: { configVersion: 1, team: { id: 'ui', parent: 'web' }, sessions: ['lead', 'pixel'], roles: { lead: 'lead' } },
};

/** The harness with `app` as the root of the tree `SUB_TEAMS` hangs under it; `root` adds to app's config. */
export async function treeHarness(root: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, team: { id: 'app' }, ...root });
  for (const [team, config] of Object.entries(SUB_TEAMS)) {
    await kit.files.write(teamConfigOf(team), formatConfig(config));
  }
  return kit;
}
