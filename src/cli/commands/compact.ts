import { basename } from 'node:path';
import { KIT_NAME } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { RETAIN_DAYS } from '../../register/compaction.ts';
import { layoutPaths, segmentName, ARCHIVE_DIR, SNAPSHOT_FILE } from '../../register/layout.ts';
import { applyRotation, planRotation, RotationRefusedError, type RotationOptions, type RotationPlan } from '../../register/rotate.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

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
    `TASKS ${compaction.kept} kept (${plan.unchanged} unchanged, ${changed} changed), ${compaction.retiredNow.length} retired now, ` +
      `${compaction.header.retired - compaction.retiredNow.length} before`,
    ...(history === null ? [] : [`HISTORY ${history.tasks} task(s) from ${history.events} event(s): the working set holds every active one as the history does`]),
    `TAIL ${tailFile} starts again with the rotation marker (${bytes(plan.markerText)})`,
  ];
}

/**
 * `compact [--dry-run]`: rotates the register under its lock (register/rotate.ts). The tail is archived
 * whole, the snapshot rewritten, and tasks finished over RETAIN_DAYS ago leave the working set for the
 * archive. Every run first reads the new files back and holds the working set against the whole history;
 * any difference refuses it with nothing written. `--dry-run` takes no lock and writes nothing.
 */
export async function compact(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const dryRun = args.switches.has('dry-run');
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, dryRun ? 'read' : 'write');
  const { files, clock, sleep, pid } = runtime;
  const paths = layoutPaths(kit.paths.events);
  const options = (): RotationOptions => ({ now: new Date(clock.now()), retainDays: RETAIN_DAYS, keep: new Set(), checkHistory: true });
  const plan = dryRun
    ? await planRotation(files, paths, options())
    : await new FileLock(kit.paths.eventsLock, config.lock, { files, clock, sleep, pid }).run(async () => {
        const planned = await planRotation(files, paths, options());
        if (planned.problems.length === 0 && !planned.idle) {
          await applyRotation(files, paths, planned);
        }
        return planned;
      });
  rotationLines(plan, basename(paths.tail)).forEach((line) => runtime.out.stdout(line));
  if (plan.problems.length > 0) {
    throw new RotationRefusedError(plan.problems);
  }
  if (plan.idle) {
    runtime.out.stdout('NOTHING TO DO: no event since the last rotation and no task to retire; nothing was written');
  } else {
    runtime.out.stdout(dryRun ? `DRY RUN: nothing was written; ${KIT_NAME} compact writes the above` : `DONE the tail is archived as ${ARCHIVE_DIR}/${segmentName(plan.segment)}; reads start from the new snapshot`);
  }
  return EXIT.ok;
}
