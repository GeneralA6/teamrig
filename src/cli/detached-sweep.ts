import type { KitConfig } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import { deadRunsOf, diedText, type DeadRun } from '../delivery/detached-runs.ts';
import { detachedDirOf } from '../delivery/places.ts';
import { teamZone, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { postUrgentLine } from './urgent-line.ts';

/** What one sweep did: the runs whose death it told, and why it could not tell or read some. */
export interface SweepResult {
  readonly told: readonly string[];
  readonly problems: readonly string[];
}

/**
 * Tells each of this team's detached queue runs that died with no end of its own (T2742: a run whose process ended
 * while it waited for the host lock never reported, and its session waited on it for hours): a DIED line in its log and
 * an urgent line, which wakes its session. A run is told once: only the sweep whose removal of its record succeeds
 * tells it, and the run itself removes its record before its own end line, so of two sweeps and the run one reports.
 * Never throws: a folder that cannot be read or a line that cannot be posted is a problem returned, the run still
 * claimed, so a refusing inbox gets no line at every check.
 */
export async function sweepDeadDetachedRuns(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<SweepResult> {
  const told: string[] = [];
  const problems: string[] = [];
  let dead: DeadRun[];
  try {
    dead = await deadRunsOf({ files: runtime.files, alive: (pid) => runtime.sessionProcesses.alive(pid) }, detachedDirOf(config.delivery, kit.paths), kit.paths.team);
  } catch (error) {
    return { told, problems: [`the detached runs were not read: ${errorMessage(error)}`] };
  }
  const zone = teamZone(config, runtime);
  for (const { path, record } of dead) {
    try {
      if (!(await runtime.files.remove(path))) {
        continue;
      }
      const text = diedText(record);
      await runtime.files.append(record.log, `${zone.second(new Date(runtime.clock.now()))} DIED ${text}\n`);
      const problem = await postUrgentLine(runtime, kit, config, { to: record.session, from: record.session, text });
      told.push(record.id);
      if (problem !== undefined) {
        problems.push(`${record.session} was not told that queue ${record.id} died: ${problem}`);
      }
    } catch (error) {
      problems.push(`queue ${record.id}'s death was not told: ${errorMessage(error)}`);
    }
  }
  return { told, problems };
}
