import { formatUtcMinute, MS_PER_DAY, MS_PER_HOUR, parseUtcDay, shortUtc } from '../core/time.ts';
import type { RegisterConfig } from '../config/types.ts';
import type { Task } from './fold.ts';
import { ACTIVE_STATUSES } from './model.ts';
import { byPlanOrder, dueTime, formatTask } from './views.ts';

/** In report order: the most urgent first. */
export const FLAG_KINDS = ['OVERDUE', 'NOT-PICKED-UP', 'OWNER-UNPLANNED', 'DUE-UNPLANNED', 'STALE'] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

export interface Flag {
  readonly kind: FlagKind;
  readonly task: Task;
  readonly detail: string;
}

/** The week plan in force: the newest week tag that starts on or before now. */
export function currentWeek(tasks: Iterable<Task>, now: Date): string | null {
  let best: string | null = null;
  for (const task of tasks) {
    const start = task.week === null ? undefined : parseUtcDay(task.week);
    if (task.week !== null && start !== undefined && start.getTime() <= now.getTime() && (best === null || task.week > best)) {
      best = task.week;
    }
  }
  return best;
}

/**
 * The daily flags over active tasks:
 * - OVERDUE: past its deadline;
 * - NOT-PICKED-UP: assigned longer ago than `notPickedUpAfterHours` with no event from its owner since
 *   (an idle session never reads its inbox, so it needs a direct wake);
 * - STALE: no event for `staleAfterHours` (not raised on top of NOT-PICKED-UP);
 * - OWNER-UNPLANNED: an owner order outside the current week plan;
 * - DUE-UNPLANNED: due inside the current week but outside its plan.
 * The two week flags need a week; null skips them.
 */
export function checkTasks(tasks: Iterable<Task>, now: Date, week: string | null, config: RegisterConfig): Flag[] {
  const { check, ownerSource } = config;
  const at = now.getTime();
  const weekStart = week === null ? undefined : parseUtcDay(week)?.getTime();
  const weekEnd = weekStart === undefined ? undefined : weekStart + check.weekLengthDays * MS_PER_DAY;
  const flags: Flag[] = [];
  for (const task of [...tasks].filter((candidate) => ACTIVE_STATUSES.includes(candidate.status)).sort(byPlanOrder)) {
    const due = dueTime(task);
    if (due !== undefined && due < at) {
      flags.push({ kind: 'OVERDUE', task, detail: `due ${shortUtc(task.due ?? '')}` });
    }
    if (task.ownerSeenAt === null && at - Date.parse(task.assignedAt) > check.notPickedUpAfterHours * MS_PER_HOUR) {
      flags.push({ kind: 'NOT-PICKED-UP', task, detail: `assigned ${minute(task.assignedAt)}, no event from ${task.owner} since` });
    } else if (at - Date.parse(task.updatedAt) > check.staleAfterHours * MS_PER_HOUR) {
      flags.push({ kind: 'STALE', task, detail: `last event ${minute(task.updatedAt)} by ${task.updatedBy}` });
    }
    if (week === null || weekStart === undefined || weekEnd === undefined || task.week === week) {
      continue;
    }
    if (task.source === ownerSource) {
      flags.push({ kind: 'OWNER-UNPLANNED', task, detail: `owner order not in week ${week}` });
    } else if (due !== undefined && due >= weekStart && due < weekEnd) {
      flags.push({ kind: 'DUE-UNPLANNED', task, detail: `due inside week ${week}, not in its plan` });
    }
  }
  return flags.sort((a, b) => FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind));
}

export function formatFlag(flag: Flag): string {
  return `${flag.kind} (${flag.detail}) ${formatTask(flag.task)}`;
}

function minute(iso: string): string {
  return shortUtc(formatUtcMinute(new Date(iso)));
}
