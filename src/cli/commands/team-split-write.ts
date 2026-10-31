import { relative } from 'node:path';
import { formatConfig } from '../../config/load.ts';
import type { KitConfig } from '../../config/types.ts';
import type { JsonRecord } from '../../core/guards.ts';
import type { TeamPaths } from '../../core/home.ts';
import { splitRenameLog } from '../../names/rename.ts';
import { runsClaude } from '../../open/session-processes.ts';
import { readRegister } from '../../register/snapshot.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { sessionFilesOf } from '../../setup/session-files.ts';
import { childRegisterOf, parentEventsOf, splitProblems } from '../../setup/split-register.ts';
import { splitTasksOf, trimmedParentOf, type SplitPlan, type SplitRewrite, type SplitTasks } from '../../setup/team-split.ts';
import { checkedNextConfig, configFileJson, configLockOf, renameDepsOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';

/**
 * The write of `team split` (T1144), once its checks pass: the moving tasks' lines go to the child's new register and
 * the parent's gets a moved line for each, under the parent register's lock; then each moved session's files move, its
 * renames, the child's config is created and the parent's trimmed, and both registers are read back and compared. Each
 * step prints its line once done. There is no resume: a step that fails leaves the lines printed before it, which say
 * what already moved.
 */

/** A moved session whose Claude Code still runs, which the split refuses: its hooks would write to the parent's files. */
export interface LiveSession {
  readonly id: string;
  readonly pid: number;
}

/** The moved sessions whose Claude Code still runs, by the record their hook keeps. */
export async function liveSessionsOf(runtime: CliRuntime, paths: TeamPaths, ids: readonly string[]): Promise<LiveSession[]> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const live: LiveSession[] = [];
  for (const [id, record] of records) {
    if (record !== undefined && (await runsClaude(runtime.sessionProcesses, record.claudePid))) {
      live.push({ id, pid: record.claudePid });
    }
  }
  return live;
}

/** Why a staying task's wait blocks the split, and what unblocks it. */
export function blockerText(blocker: SplitRewrite): string {
  return `${blocker.task} waits on ${blocker.from}'s ${blocker.field}, and ${blocker.from} moves: ask it of a session that stays, then split`;
}

/** Why a live moved session blocks the split, and what unblocks it. */
export function liveText(session: LiveSession): string {
  return `${session.id}'s Claude Code runs (pid ${session.pid}): close its tab, then split`;
}

export interface SplitWrite {
  readonly runtime: CliRuntime;
  readonly kit: Kit;
  readonly config: KitConfig;
  /** The parent's config file as written, which the split trims. */
  readonly record: JsonRecord;
  /** The lead, who writes the split. */
  readonly by: string;
  readonly plan: SplitPlan;
  readonly childPaths: TeamPaths;
}

/** The name the parent's config is kept under before a split trims it (`config.split.json`). */
export const SPLIT_BACKUP_NAME = 'config.split';

/** Refuses a split its plan blocks, a moved session still open, or a config either team could not hold. */
async function checkSplit(split: SplitWrite): Promise<void> {
  const { runtime, kit, plan } = split;
  if (plan.blockers.length > 0) {
    throw new RefusedError(plan.blockers.map(blockerText).join('; '));
  }
  const live = await liveSessionsOf(runtime, kit.paths, plan.spec.sessions);
  if (live.length > 0) {
    throw new RefusedError(live.map(liveText).join('; '));
  }
  checkedNextConfig(plan.config);
  checkedNextConfig(trimmedParentOf(split.record, new Set(plan.spec.sessions)));
}

/**
 * Under the config lock: the parent's config as it reads now, less the moved sessions, so a change written since the
 * split read it (a hire) is kept; the old file is kept first, and its path returned.
 */
async function trimParent(split: SplitWrite): Promise<string> {
  const { runtime, kit, config, plan } = split;
  return configLockOf(runtime, kit, config).run(async (writer) => {
    const trimmed = trimmedParentOf(await configFileJson(runtime, kit.load.path), new Set(plan.spec.sessions));
    checkedNextConfig(trimmed);
    return writer.write(trimmed, SPLIT_BACKUP_NAME);
  });
}

/**
 * Under the parent register's lock: the tasks as the locked working set holds them, refused when a wait there blocks;
 * the child's register created with their lines, and the parent's events of the split. The child's register is created
 * exclusively, so a second split into the same team refuses here.
 */
async function moveTasks(split: SplitWrite): Promise<SplitTasks> {
  const { runtime, kit, config, plan, childPaths, by } = split;
  const register = teamRegister(runtime, kit.paths, config);
  const at = new Date(runtime.clock.now()).toISOString();
  let locked: SplitTasks = plan;
  const moved = await register.moveOut(by, async (snapshot) => {
    locked = splitTasksOf(snapshot.state.tasks, plan.border);
    if (locked.blockers.length > 0) {
      return { ok: false, error: locked.blockers.map(blockerText).join('; ') };
    }
    const lines = childRegisterOf(snapshot.read, new Set(locked.moving.map((task) => task.id)), plan.border);
    if (!(await runtime.files.createExclusive(childPaths.events, lines))) {
      return { ok: false, error: `${childPaths.events} exists already; a split makes a new team` };
    }
    return { ok: true, value: parentEventsOf(locked, plan.spec.team, by, at) };
  });
  if (!moved.ok) {
    throw new RefusedError(moved.error);
  }
  return locked;
}

/** Moves each file the parent keeps for a moved session to the same place in the child's folders. */
async function moveFiles(split: SplitWrite, id: string): Promise<string[]> {
  const { runtime, kit, childPaths } = split;
  const targets = sessionFilesOf(childPaths, id);
  const moved: string[] = [];
  for (const [index, from] of sessionFilesOf(kit.paths, id).entries()) {
    const to = targets[index];
    if (to !== undefined && (await runtime.files.move(from, to))) {
      moved.push(relative(kit.paths.home, from));
    }
  }
  return moved;
}

/** Under the parent's rename lock: the moved sessions' renames go to the child's log, the parent's keeps the rest. */
async function moveRenames(split: SplitWrite): Promise<number> {
  const { runtime, kit, config, childPaths, plan } = split;
  return renameDepsOf(runtime, kit, config).mutex.run(async () => {
    const parts = splitRenameLog((await runtime.files.read(kit.paths.renames)) ?? '', new Set(plan.spec.sessions));
    if (parts.moved > 0) {
      await runtime.files.write(childPaths.renames, parts.of);
      await runtime.files.write(kit.paths.renames, parts.rest);
    }
    return parts.moved;
  });
}

/** Runs the split's steps in order, printing each; EXIT.failed when the registers read back otherwise than they should. */
export async function writeTeamSplit(split: SplitWrite): Promise<ExitCode> {
  const { runtime, kit, plan, childPaths } = split;
  const out = (line: string): void => runtime.out.stdout(line);
  const parent = kit.paths.team;
  const child = plan.spec.team;
  await checkSplit(split);
  const locked = await moveTasks(split);
  out(`MOVED ${locked.moving.length} task(s) to ${childPaths.events}; ${parent}'s register sends each there`);
  for (const id of plan.spec.sessions) {
    const files = await moveFiles(split, id);
    out(`FILES ${id}: ${files.length === 0 ? 'none kept' : files.join(', ')}`);
  }
  out(`RENAMES ${await moveRenames(split)} line(s) moved`);
  if (!(await runtime.files.createExclusive(childPaths.config, formatConfig(plan.config)))) {
    throw new RefusedError(`${childPaths.config} exists already; a split makes a new team`);
  }
  out(`CREATED ${childPaths.config}`);
  const backup = await trimParent(split);
  out(`TRIMMED ${kit.load.path}: sessions ${plan.spec.sessions.join(', ')} left; the old config is at ${backup}`);
  const childState = readRegister((await runtime.files.read(childPaths.events)) ?? '').state;
  const parentState = (await teamRegister(runtime, kit.paths, split.config).snapshot()).state;
  const problems = splitProblems(locked.moving, childState, parentState, child);
  if (problems.length > 0) {
    problems.forEach((problem) => out(`PROBLEM ${problem}`));
    return EXIT.failed;
  }
  out(`VERIFIED ${locked.moving.length} task(s) read the same in ${child}, and ${parent} sends each there`);
  out(`NEXT reopen each moved session from its team: ${plan.spec.sessions.map((id) => `teamrig open ${child}/${id}`).join('; ')}`);
  return EXIT.ok;
}
