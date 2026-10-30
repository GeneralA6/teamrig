import { basename } from 'node:path';
import { HOOK_LOG_AGE, type AgeArchivePlan } from '../../core/aged-log.ts';
import { KIT_NAME } from '../../core/home.ts';
import { RETAIN_DAYS } from '../../register/compaction.ts';
import { layoutPaths, segmentName, ARCHIVE_DIR, SNAPSHOT_FILE } from '../../register/layout.ts';
import { applyRotation, planRotation, RotationRefusedError, type Rebuild, type RotationOptions, type RotationPlan } from '../../register/rotate.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { HOOK_LOGS, hookLogOf } from '../hook-logs.ts';
import { openTeamKit, requireConfig, teamZone } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { fileLockOf } from '../file-locks.ts';

function bytes(text: string): string {
  return `${Buffer.byteLength(text, 'utf8').toLocaleString('en-US')} B`;
}

/** What a rotation archives, writes and checks, one line each, as a dry run and a run print it. */
export function rotationLines(plan: RotationPlan, tailFile: string): string[] {
  const { compaction, history } = plan;
  const segment = `${ARCHIVE_DIR}/${segmentName(plan.segment)}`;
  const skipped = plan.skippedSnapshot === null ? '' : `; the old snapshot is skipped: ${plan.skippedSnapshot}`;
  const changed = compaction.kept - plan.unchanged;
  return [
    `ARCHIVE ${tailFile} (${plan.tailEvents} event(s), ${bytes(plan.tailText)}) as ${segment}${plan.leftover ? ', replacing what a stopped rotation left there' : ''}`,
    `SNAPSHOT ${SNAPSHOT_FILE}: ${compaction.header.events} event(s), ${bytes(compaction.text)}, covering segments 1-${plan.segment}; ` +
      `folded from the ${plan.source} (${plan.sourceEvents} event(s))${skipped}`,
    ...(plan.rebuild === null ? [] : rebuildLines(plan.rebuild)),
    `TASKS ${compaction.kept} kept (${plan.unchanged} unchanged, ${changed} changed), ${compaction.retiredNow.length} retired now, ` +
      `${compaction.header.retired - compaction.retiredNow.length} before`,
    ...(history === null ? [] : [`HISTORY ${history.tasks} task(s) from ${history.events} event(s): the working set holds every active one as the history does`]),
    `TAIL ${tailFile} starts again with the rotation marker (${bytes(plan.markerText)})`,
  ];
}

/** What `--from-history` changes: the lines read again from the archive, then each way the old working set differed. */
function rebuildLines(rebuild: Rebuild): string[] {
  const { differences, restoredLines } = rebuild;
  return [
    `REBUILD from the history in place of the old snapshot: ${restoredLines} line(s) read again from the archive, ${differences.length} difference(s) from the old working set repaired`,
    ...differences.map((difference) => `REPAIR ${difference}`),
  ];
}

/** What an aged log's archive run moves and keeps, in one line. */
export function agedLine(plan: AgeArchivePlan, keepDays: number): string {
  const { movedLines, keptLines } = plan.split;
  const moved = movedLines === 0 ? 'no line' : `${movedLines} line(s)`;
  const target = movedLines === 0 ? '' : ` to ${ARCHIVE_DIR}/${basename(plan.archiveFile)}`;
  return `AGED ${plan.name}: ${moved} older than ${keepDays} days${target}, ${keptLines} kept`;
}

/**
 * `compact [--dry-run] [--from-history]`: rotates the register under its lock (register/rotate.ts). The tail is
 * archived whole, the snapshot rewritten, and tasks finished over RETAIN_DAYS ago leave the working set for the
 * archive. Every run first reads the new files back and holds the working set against the whole history;
 * any difference refuses it with nothing written, and one the history check found points to `--from-history`,
 * which folds the new snapshot from the whole history instead of the old snapshot. Then the hooks' aged logs
 * move their records older than a week to the archive, as their writes do when due (cli/hook-logs.ts).
 * `--dry-run` takes no lock and writes nothing.
 */
export async function compact(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const dryRun = args.switches.has('dry-run');
  const fromHistory = args.switches.has('from-history');
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, dryRun ? 'read' : 'write');
  const { files, clock } = runtime;
  const paths = layoutPaths(kit.paths.events);
  const zone = teamZone(config, runtime);
  const options = (): RotationOptions => ({ now: new Date(clock.now()), zone, retainDays: RETAIN_DAYS, keep: new Set(), checkHistory: true, fromHistory });
  const plan = dryRun
    ? await planRotation(files, paths, options())
    : await fileLockOf(runtime, kit.paths.eventsLock, config.lock).run(async () => {
        const planned = await planRotation(files, paths, options());
        if (planned.problems.length === 0 && !planned.idle) {
          await applyRotation(files, paths, planned);
        }
        return planned;
      });
  rotationLines(plan, basename(paths.tail)).forEach((line) => runtime.out.stdout(line));
  if (plan.problems.length > 0) {
    if (plan.historyDiffers) {
      runtime.out.stdout(`HINT the archive holds the whole history: ${KIT_NAME} compact --from-history --dry-run shows a snapshot rebuilt from it`);
    }
    throw new RotationRefusedError(plan.problems);
  }
  const { keepDays } = HOOK_LOG_AGE;
  const aged: AgeArchivePlan[] = [];
  for (const name of HOOK_LOGS) {
    const log = hookLogOf(runtime, kit.paths, name);
    aged.push(dryRun ? await log.plan() : await log.archive());
  }
  aged.forEach((agedPlan) => runtime.out.stdout(agedLine(agedPlan, keepDays)));
  const agedIdle = aged.every((agedPlan) => agedPlan.split.moved === '');
  if (plan.idle && agedIdle) {
    runtime.out.stdout(`NOTHING TO DO: no event since the last rotation, no task to retire and no hook record over ${keepDays} days old; nothing was written`);
  } else if (dryRun) {
    runtime.out.stdout(`DRY RUN: nothing was written; ${KIT_NAME} compact writes the above`);
  } else if (plan.idle) {
    runtime.out.stdout(`DONE the hook records over ${keepDays} days old are archived; the register had nothing to rotate`);
  } else {
    runtime.out.stdout(`DONE the tail is archived as ${ARCHIVE_DIR}/${segmentName(plan.segment)}; reads start from the new snapshot`);
  }
  return EXIT.ok;
}
