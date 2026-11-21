import { MeterLog } from '../../budget/calibration.ts';
import { limitSpansOf } from '../../budget/extra.ts';
import { SecretScanner } from '../../core/secrets.ts';
import type { TimeZone } from '../../core/zone.ts';
import { statsBody, type Connector } from '../../interface/index.ts';
import type { Goal } from '../../register/goals.ts';
import { layoutPaths } from '../../register/layout.ts';
import { registerHealth } from '../../register/stats-health.ts';
import { dayEndOf, registerStats, type StatsTask } from '../../register/stats.ts';
import { dueTime } from '../../register/views.ts';
import { accountWeekOn } from '../account-teams.ts';
import { teamZone } from '../kit.ts';
import { teamsFolderOf } from '../tree.ts';
import { goalsFilesOf, heldGoalsOf } from './read-goals.ts';
import { once, stampsOf, wholeHistoryOf, type DocumentSource, type ReadScope } from './read-source.ts';

/**
 * `stats`: the register's numbers over `--range` of the team's calendar days, as `teamrig stats` and the pane's Stats
 * tab fold them, with their Health levels. It reads the team's whole history (the archive's segments, then the live
 * log), since a range reaches past what a compaction left in the working set, so its cost grows with the archive; the
 * goals of the team and the teams above it, as `goals` serves them; and the meter log of the team's account for the
 * days the week sat at its usage limit, found as `teamrig stats` finds it (`accountWeekOn`, which reads the tree's
 * configs and the status line's readings, and writes nothing). `--owner` narrows the count to that session's tasks.
 *
 * A number counted in days of age (`oldestDays`, an area's `waits` cell) is as of the answer's `at`: the clock is no
 * part of the revision, so the answer says in `validUntil` when it next goes stale by the clock alone (the end of the
 * team's day, or an active task's due, the nearer). Only the asked team is counted: a tree's teams are below it, and a
 * read serves the own team and those above it only.
 */
export function statsSource(connectors: readonly Connector[]): (scope: ReadScope) => DocumentSource {
  return (scope) => {
    const { runtime, kit, config, range } = scope;
    const layout = layoutPaths(kit.paths.events);
    const meterLog = once(async () => (await accountWeekOn(runtime, config.budget, kit.paths, runtime.clock.now())).paths.meterLog);
    return {
      async parts() {
        const loaded = await scope.tree();
        const configs = [...[...loaded.teams.values()].map((other) => other.kit.load.path), ...[...loaded.leftOut.values()].map((load) => load.path)];
        return {
          document: 'stats',
          args: [
            ['team', kit.paths.team],
            ['owner', scope.owner],
            ['range', range],
          ],
          stamps: [
            // A team folder added or removed moves no file the tree read: the folder's own listing tells, as in `goals`.
            (await runtime.files.list(teamsFolderOf(runtime))).join(','),
            ...(await stampsOf(runtime, [...configs, kit.paths.renames, layout.snapshot, layout.tail])),
            // A segment is written once and counts by name, as in `tasks`: one that went missing and came back changes the answer.
            (await runtime.files.list(layout.archive)).join(','),
            ...(await stampsOf(runtime, [...goalsFilesOf(loaded, kit.paths), await meterLog()])),
          ],
        };
      },
      async build() {
        const now = runtime.clock.now();
        const zone = teamZone(config, runtime);
        const history = await wholeHistoryOf(runtime, kit.paths, layout);
        const held = await heldGoalsOf(scope);
        // The root's goals first and the own team's last, so a nearer team's goal of the same tag is the one kept.
        const goals = new Map<string, Goal>(held.held.flatMap((team) => [...team.goals].map((goal): [string, Goal] => [goal.tag, goal])));
        const limits = limitSpansOf(await new MeterLog(runtime.files, await meterLog()).read(now));
        const stats = registerStats({
          teams: [{ team: kit.paths.team, lead: config.roles.lead, events: history.events }],
          range,
          now: new Date(now),
          zone,
          ownerMarker: config.register.ownerSource,
          limits,
          goals,
          ...(scope.owner === null ? {} : { session: { team: kit.paths.team, session: scope.owner } }),
        });
        const body = statsBody({
          stats,
          health: registerHealth(stats),
          session: scope.owner,
          now,
          validUntil: validUntilOf(stats.tasks.active, now, zone),
          shapes: new SecretScanner(config.register.secretPatterns),
          names: { owner: config.register.ownerSource, connectors },
        });
        return { body, problems: [...history.problems, ...held.problems] };
      },
    };
  };
}

/** The end of the team's day, or the nearest due of an active task after `now` when that comes first. */
function validUntilOf(active: readonly StatsTask[], now: number, zone: TimeZone): number {
  return active.reduce((nearest, { task }) => {
    const due = dueTime(task, zone);
    return due !== undefined && due > now && due < nearest ? due : nearest;
  }, dayEndOf(new Date(now), zone));
}
