import { lineFrontPath, LineFrontStore } from '../../delivery/line-front-store.ts';
import { ACTIVE_STATUSES, TASK_ID } from '../../register/model.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { UsageError, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { leadOnly, openTeamKit, requireConfig, rosterOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `teamrig pipeline front <task>` puts one of the team's active tasks at the front of the host line: its queued steps
 * go first, so a blocker's fix no longer waits behind every step queued before it (T4082). `--off` takes the front
 * off. The lead only, since it moves every other session's steps back; one task at a time, a new one replacing the
 * last. Exit 0 done, 2 refused.
 */
export async function pipelineFront(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const off = args.switches.has('off');
  const [task, ...extra] = args.positionals;
  if (extra.length > 0 || (off ? task !== undefined : task === undefined)) {
    throw new UsageError('give one task, such as T5, or --off alone');
  }
  if (task !== undefined && !TASK_ID.test(task)) {
    throw new UsageError(`"${task}" is not a task id, such as T5`);
  }
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'read');
  const by = leadOnly(await rosterOf(runtime, kit, config), callerOf(args.flags, runtime.env), off ? 'takes a task off the front of the host line' : 'puts a task at the front of the host line');
  const store = new LineFrontStore(runtime.files, lineFrontPath(kit.paths.state));
  const was = await store.read();
  if (task === undefined) {
    await store.clear();
    runtime.out.stdout(was === undefined ? 'OFF none: no task was at the front of the host line' : `OFF ${was.task}: its queued steps wait in the line's usual order again`);
    return EXIT.ok;
  }
  const found = (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(task);
  if (found === undefined) {
    throw new RefusedError(`the register has no ${task}`);
  }
  if (!ACTIVE_STATUSES.includes(found.status)) {
    throw new RefusedError(`${task} is ${found.status}: only an active task (${ACTIVE_STATUSES.join(', ')}) goes to the front`);
  }
  if (was?.task === task) {
    // Kept as it was: its time orders the teams' fronts in the host-wide line, so a repeat must not move it back.
    runtime.out.stdout(`FRONT ${task}: already at the front of the host line`);
    return EXIT.ok;
  }
  await store.put({ task, at: new Date(runtime.clock.now()).toISOString(), by });
  runtime.out.stdout(`FRONT ${task}: its queued steps go first in the host line${was === undefined ? '' : ` (replaces ${was.task})`}`);
  return EXIT.ok;
}
