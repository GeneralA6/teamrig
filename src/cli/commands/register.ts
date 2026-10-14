import type { KitConfig } from '../../config/types.ts';
import type { KitPaths } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { checkTasks, currentWeek, formatFlag } from '../../register/check.ts';
import { renderPlan } from '../../register/plan.ts';
import { RegisterPolicy, type Verdict } from '../../register/policy.ts';
import { Register, type RegisterSnapshot, type WriteResult } from '../../register/register.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { formatTask, formatTaskDetail, selectTasks } from '../../register/views.ts';
import { formatSkillFlag, lintSkills } from '../../skills/lint.ts';
import { SkillDir } from '../../skills/store.ts';
import { noPositionals, onePositional, type ParsedArgs } from '../args.ts';
import { addInputOf, callerOf, changesOf, listFilterOf, statusInputOf, taskIdOf, weekOf } from '../inputs.ts';
import { openKit, requireConfig, type Access } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

interface Team {
  readonly config: KitConfig;
  readonly paths: KitPaths;
  readonly register: Register;
}

async function openTeam(runtime: CliRuntime, access: Access): Promise<Team> {
  const kit = await openKit(runtime);
  const config = requireConfig(kit, runtime, access);
  const { files, clock, sleep, pid } = runtime;
  const register = new Register({
    log: new JsonlEventLog(files, kit.paths.events),
    mutex: new FileLock(kit.paths.eventsLock, config.lock, { files, clock, sleep, pid }),
    clock,
    policy: new RegisterPolicy(config),
    skills: new SkillDir(files, kit.paths.skills),
  });
  return { config, paths: kit.paths, register };
}

function report(runtime: CliRuntime, verdict: Verdict<WriteResult>, verb: string): ExitCode {
  if (!verdict.ok) {
    throw new RefusedError(verdict.error);
  }
  runtime.out.stdout(`${verb} ${formatTask(verdict.value.task)}`);
  return EXIT.ok;
}

/** Damaged or newer lines never stop a read; they are named on stderr so someone fixes them. */
function warnDamage(runtime: CliRuntime, snapshot: RegisterSnapshot, path: string): void {
  const { unreadable, newer } = snapshot.read;
  const { orphans } = snapshot.state;
  if (unreadable + newer + orphans > 0) {
    runtime.out.stderr(
      `WARN ${path}: ${unreadable} unreadable line(s), ${newer} line(s) from a newer teamrig, ${orphans} event(s) naming no task`,
    );
  }
}

async function readTeam(runtime: CliRuntime): Promise<{ readonly team: Team; readonly snapshot: RegisterSnapshot }> {
  const team = await openTeam(runtime, 'read');
  const snapshot = await team.register.snapshot();
  warnDamage(runtime, snapshot, team.paths.events);
  return { team, snapshot };
}

export async function add(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const input = addInputOf(args.flags, caller);
  const { register } = await openTeam(runtime, 'write');
  return report(runtime, await register.add(caller, input), 'ADDED');
}

export async function set(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const input = statusInputOf(args.flags);
  const { register } = await openTeam(runtime, 'write');
  return report(runtime, await register.setStatus(caller, id, input), 'SET');
}

export async function update(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const caller = callerOf(args.flags, runtime.env);
  const changes = changesOf(args.flags);
  const { register } = await openTeam(runtime, 'write');
  return report(runtime, await register.update(caller, id, changes, args.flags.get('note')), 'UPDATED');
}

export async function list(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const filter = listFilterOf(args.flags);
  const { snapshot } = await readTeam(runtime);
  for (const task of selectTasks(snapshot.state.tasks.values(), filter)) {
    runtime.out.stdout(formatTask(task));
  }
  return EXIT.ok;
}

export async function show(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const id = taskIdOf(onePositional(args, 'id'));
  const { snapshot } = await readTeam(runtime);
  const task = snapshot.state.tasks.get(id);
  if (task === undefined) {
    throw new RefusedError(`no task ${id}`);
  }
  runtime.out.stdout(formatTaskDetail(task, snapshot.read.events.filter((event) => event.id === id)));
  return EXIT.ok;
}

/** The `--week` given, else the newest week plan that has started. */
function weekFor(args: ParsedArgs, snapshot: RegisterSnapshot, now: Date): string | null {
  const week = args.flags.get('week');
  return week === undefined ? currentWeek(snapshot.state.tasks.values(), now) : weekOf(week);
}

export async function check(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { team, snapshot } = await readTeam(runtime);
  const now = new Date(runtime.clock.now());
  const week = weekFor(args, snapshot, now);
  const flags = checkTasks(snapshot.state.tasks.values(), now, week, team.config.register);
  const scope = week === null ? 'no week plan tagged yet, so the week checks are skipped' : `week ${week}`;
  runtime.out.stdout(`CHECK ${flags.length} flag(s), ${scope}`);
  flags.forEach((flag) => runtime.out.stdout(formatFlag(flag)));
  const skills = lintSkills(await new SkillDir(runtime.files, team.paths.skills).readAll(), now, team.config);
  runtime.out.stdout(`SKILLS ${skills.length} flag(s) in ${team.paths.skills}`);
  skills.forEach((flag) => runtime.out.stdout(formatSkillFlag(flag)));
  return EXIT.ok;
}

export async function plan(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { team, snapshot } = await readTeam(runtime);
  const now = new Date(runtime.clock.now());
  const week = weekFor(args, snapshot, now);
  if (week === null) {
    throw new RefusedError('no week plan tagged yet; pass --week <YYYY-MM-DD>');
  }
  runtime.out.stdout(renderPlan(snapshot.state.tasks.values(), week, now, team.config.register));
  return EXIT.ok;
}
