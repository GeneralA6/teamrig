import type { KitConfig } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import { deadRunsOf, diedEndOf, diedText, type DeadRun, type LedgerStep } from '../delivery/detached-runs.ts';
import { appendRecord, parseLedger } from '../delivery/ledger.ts';
import { hasParked, parkedDirOf } from '../delivery/parked.ts';
import { detachedDirOf } from '../delivery/places.ts';
import { ensureDispatcher } from './commands/queue-dispatch.ts';
import { teamZone, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { postUrgentLine } from './urgent-line.ts';

/** What one sweep did: the runs whose death it told, and why it could not tell or read some. */
export interface SweepResult {
  readonly told: readonly string[];
  readonly problems: readonly string[];
}

/**
 * Appends the end record of a dead run's step, unless the ledger has one: a run that died after its own end record,
 * before it removed its run record, keeps its real exit. Returns the problem when the ledger cannot be read or written.
 */
async function closeDiedStep(runtime: CliRuntime, step: LedgerStep): Promise<string | undefined> {
  try {
    const ended = parseLedger((await runtime.files.read(step.ledger)) ?? '').some((entry) => entry.type === 'heavy' && entry.id === step.start.id && entry.endedAt !== null);
    if (!ended) {
      await appendRecord(runtime.files, step.ledger, diedEndOf(step.start, new Date(runtime.clock.now()).toISOString()));
    }
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Tells each of this team's detached queue runs that died with no end of its own (T2742: a run whose process ended
 * while it waited for the host lock never reported, and its session waited on it for hours): a DIED line in its log and
 * an urgent line, which wakes its session. A run is told once: only the sweep whose removal of its record succeeds
 * tells it, and the run itself removes its record before its own end line, so of two sweeps and the run one reports.
 * Never throws: a folder that cannot be read or a line that cannot be posted is a problem returned, the run still
 * claimed, so a refusing inbox gets no line at every check. A run that died while its step ran also has that step's
 * ledger record closed (T2942): its own end never came, and a start record left open counts as a step running for ever.
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
    let claimed = false;
    try {
      claimed = await runtime.files.remove(path);
      if (!claimed) {
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
    if (claimed && record.step !== undefined) {
      const problem = await closeDiedStep(runtime, record.step);
      if (problem !== undefined) {
        problems.push(`queue ${record.id}'s step was not closed in the ledger: ${problem}`);
      }
    }
  }
  const restart = await restartDispatcher(runtime, detachedDirOf(config.delivery, kit.paths));
  return { told, problems: restart === undefined ? problems : [...problems, restart] };
}

/**
 * Starts a dispatcher for steps left parked with none running (T4093): one whose dispatcher died, as at a reboot,
 * would else wait for ever, as nothing else starts one until the next `queue --detach`. Returns the problem, if any.
 */
async function restartDispatcher(runtime: CliRuntime, dir: string): Promise<string | undefined> {
  try {
    if (!(await hasParked(runtime.files, parkedDirOf(dir)))) {
      return undefined;
    }
    const problem = await ensureDispatcher(runtime, dir);
    return problem === undefined ? undefined : `the parked queue steps have no dispatcher, and none started: ${problem}`;
  } catch (error) {
    return `the parked queue steps were not looked at: ${errorMessage(error)}`;
  }
}
