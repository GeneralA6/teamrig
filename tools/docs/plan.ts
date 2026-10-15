/**
 * The README's planning picture: the lead plans one week from the tokens left, in four steps. First the week's tokens,
 * from one reset to the next; then the tasks fill the days, most important first, up to 99.5% of the limit; then the
 * last 0.5% is kept for incidents; then the task that does not fit moves to next week. Each step fades in and holds,
 * the whole plan fades out and the loop starts again, in one CSS loop and no script, so GitHub shows it in an <img>.
 * With motion turned off it is a still of the finished plan. It follows the reader's light or dark colour scheme.
 */
import { escapeXml, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 196;

/** 15.4 s a loop; the plan fades out at 14.6 s; the still shows 13.8 s, when the plan is finished. */
export const PLAN_CLOCK: Clock = { loop: 15.4, end: 14.6, rest: 13.8 };

/**
 * When each step shows, in seconds: the week's tokens, the first task (the next ones follow `taskStep` apart), the
 * reserve and next week. The gaps leave time to read one step before the next.
 */
export const PLAN_STEPS = { tokens: 0.6, tasks: 2.4, taskStep: 0.8, reserve: 6, nextWeek: 8 } as const;

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface PlanTask {
  readonly title: string;
  readonly priority: Priority;
  /** The token estimate, in percent of the weekly limit. */
  readonly estimate: number;
}

/** The share of the weekly limit the plan may fill, in percent; the rest is kept for incidents. */
export const PLAN_FILL = 99.5;

/** The team's tasks for the week: three fill it to 99.5% and the last does not fit. */
export const BACKLOG: readonly PlanTask[] = [
  { title: 'Signup flow', priority: 'p1', estimate: 45 },
  { title: 'Profile page', priority: 'p2', estimate: 32 },
  { title: 'Dark mode', priority: 'p3', estimate: 22.5 },
  { title: 'Export', priority: 'p4', estimate: 9 },
];

/** How strongly each priority's tasks are tinted purple: the most urgent the strongest. */
export const PRIORITY_SHADE: Readonly<Record<Priority, number>> = { p1: 0.5, p2: 0.3, p3: 0.16, p4: 0.08 };

export interface WeekPlan {
  /** The tasks in the week, in priority order. */
  readonly planned: readonly PlanTask[];
  /** The tasks that did not fit, in priority order. */
  readonly nextWeek: readonly PlanTask[];
  /** The planned share of the weekly limit, in percent. */
  readonly used: number;
}

/**
 * Fills the week in priority order, p1 first and the backlog's order within a priority: a task goes in while the
 * plan stays within `fill` percent of the limit, else it moves to next week, and a smaller task after it may still fit.
 */
export function planWeek(backlog: readonly PlanTask[], fill: number): WeekPlan {
  const planned: PlanTask[] = [];
  const nextWeek: PlanTask[] = [];
  let used = 0;
  const rank = (task: PlanTask): number => PRIORITIES.indexOf(task.priority);
  for (const task of [...backlog].sort((a, b) => rank(a) - rank(b))) {
    if (used + task.estimate <= fill + 1e-9) {
      planned.push(task);
      used += task.estimate;
    } else {
      nextWeek.push(task);
    }
  }
  return { planned, nextWeek, used };
}

/** The week runs from one reset (x0) to the next (x1), a day to a column; the token bar's top and height. */
const WEEK = { x0: 40, x1: 720, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } as const;
const BAR = { top: 46, height: 68 } as const;
/** The baseline of the labels above the bar, of the days below it and of the caption under the days. */
const ROWS = { above: 32, days: 136, caption: 176 } as const;
/** The next-week tray: its left edge and width. */
const TRAY = { x: 780, width: 150 } as const;
/** A card sits this far inside the bar, top and bottom. */
const INSET = 5;

const dayWidth = (WEEK.x1 - WEEK.x0) / WEEK.days.length;
const percent = (value: number): string => `${Number(value.toFixed(1))}%`;

/** Where a share of the weekly limit, in percent, falls on the bar. */
export const barX = (share: number): number => WEEK.x0 + ((WEEK.x1 - WEEK.x0) * share) / 100;

/** The left and right resets' x: the bar's ends. */
export const RESETS = [WEEK.x0, WEEK.x1] as const;

/** A planned task's place on the bar. */
export interface Block {
  readonly task: PlanTask;
  readonly x: number;
  readonly width: number;
}

/** The planned tasks, end to end from the left reset, each as wide as its share of the weekly limit. */
export function layOut(planned: readonly PlanTask[]): Block[] {
  let share = 0;
  return planned.map((task) => {
    const block = { task, x: barX(share), width: barX(share + task.estimate) - barX(share) };
    share += task.estimate;
    return block;
  });
}

/** A task as a card, its title over its priority and estimate: tinted by priority in the week, dashed and muted when it waits. */
function card(task: PlanTask, x: number, width: number, waits: boolean): string[] {
  const words = waits ? ' later-words' : '';
  return [
    `<rect x="${(x + 2).toFixed(1)}" y="${BAR.top + INSET}" width="${(width - 4).toFixed(1)}" height="${BAR.height - 2 * INSET}" rx="5" class="${waits ? 'later' : task.priority}"/>`,
    `<text x="${(x + 14).toFixed(1)}" y="${BAR.top + 30}" class="title${words}">${escapeXml(task.title)}</text>`,
    `<text x="${(x + 14).toFixed(1)}" y="${BAR.top + 51}" class="est${words}">${task.priority} · ${percent(task.estimate)}</text>`,
  ];
}

/** Step 1: the week's tokens, a bar from one reset to the next, the days under it. */
function tokens(t: Timeline): string[] {
  return [
    `<g data-step="tokens" class="${t.show(PLAN_STEPS.tokens, { motion: 'fade' })}">`,
    `<text x="${WEEK.x0}" y="${ROWS.above}" class="head">Tokens for this week</text>`,
    `<rect x="${WEEK.x0}" y="${BAR.top}" width="${WEEK.x1 - WEEK.x0}" height="${BAR.height}" rx="7" class="track"/>`,
    ...WEEK.days.slice(1).map((_, d) => `<path d="M${(WEEK.x0 + (d + 1) * dayWidth).toFixed(1)} ${BAR.top}v${BAR.height}" class="day-line"/>`),
    ...WEEK.days.map((day, d) => `<text x="${(WEEK.x0 + (d + 0.5) * dayWidth).toFixed(1)}" y="${ROWS.days}" text-anchor="middle" class="day">${day}</text>`),
    ...RESETS.map((x) => `<text x="${x}" y="${ROWS.days}" text-anchor="middle" class="reset">reset</text>`),
    `</g>`,
  ];
}

/** Step 2: the tasks fill the days one after another, most important first, with the caption that says so. */
function tasks(plan: WeekPlan, t: Timeline): string[] {
  return [
    `<g data-step="tasks">`,
    `<text x="${WEEK.x0}" y="${ROWS.caption}" class="caption ${t.show(PLAN_STEPS.tasks, { motion: 'fade' })}">Tasks fill the days, most important first, up to ${percent(plan.used)}</text>`,
    ...layOut(plan.planned).flatMap((block, i) => [
      `<g data-task="${block.task.priority}" class="${t.show(PLAN_STEPS.tasks + i * PLAN_STEPS.taskStep, { motion: 'fade' })}">`,
      ...card(block.task, block.x, block.width, false),
      `</g>`,
    ]),
    `</g>`,
  ];
}

/** Step 3: the rest of the limit, after the last task, kept for incidents. */
function reserve(plan: WeekPlan, t: Timeline): string[] {
  const left = barX(plan.used);
  const middle = ((left + WEEK.x1) / 2).toFixed(1);
  return [
    `<g data-step="reserve" class="${t.show(PLAN_STEPS.reserve, { motion: 'fade' })}">`,
    `<rect x="${left.toFixed(1)}" y="${BAR.top}" width="${(WEEK.x1 - left).toFixed(1)}" height="${BAR.height}" class="reserve"/>`,
    `<path d="M${middle} ${ROWS.above + 5}V${BAR.top}" class="pointer"/>`,
    `<text x="${WEEK.x1}" y="${ROWS.above}" text-anchor="end" class="head">${percent(100 - plan.used)} kept for incidents</text>`,
    `</g>`,
  ];
}

/** Step 4: what does not fit moves past the reset, to next week. */
function nextWeek(plan: WeekPlan, t: Timeline): string[] {
  const middle = BAR.top + BAR.height / 2;
  return [
    `<g data-step="next-week" class="${t.show(PLAN_STEPS.nextWeek, { motion: 'fade' })}">`,
    `<text x="${TRAY.x}" y="${ROWS.above}" class="head">Moves to next week</text>`,
    `<path d="M${WEEK.x1 + 12} ${middle}H${TRAY.x - 10}m-7 -6l7 6l-7 6" class="arrow"/>`,
    ...plan.nextWeek.slice(0, 1).flatMap((task) => card(task, TRAY.x - 2, TRAY.width, true)),
    `</g>`,
  ];
}

/** The picture as an SVG file. */
export function renderPlan(): string {
  const plan = planWeek(BACKLOG, PLAN_FILL);
  const t = new Timeline(PLAN_CLOCK);
  const body = [...tokens(t), ...tasks(plan, t), ...reserve(plan, t), ...nextWeek(plan, t)];
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label:
      'Your lead plans the week from the tokens you have left. The tasks fill the days, most important first, until ' +
      `the plan reaches ${percent(plan.used)} of your weekly limit. The last ${percent(100 - plan.used)} is kept for ` +
      "incidents, and the task that doesn't fit moves to next week.",
    style: [
      ...themeStyle(),
      '.head{font-size:17px;font-weight:600}.caption{font-size:16px}.day{font-size:14px;fill:var(--muted)}.reset{font-size:13px;fill:var(--muted)}',
      '.title{font-size:16px;font-weight:600}.est{font-size:14px}',
      ...PRIORITIES.map((priority) => `.${priority}{fill:var(--purple);fill-opacity:${PRIORITY_SHADE[priority]}}`),
      '.later{fill:none;stroke:var(--muted);stroke-width:1.4;stroke-dasharray:6 4}.later-words{fill:var(--muted)}',
      '.track{fill:none;stroke:var(--line);stroke-width:1.4}.day-line{stroke:var(--line);stroke-width:1;stroke-dasharray:2 4}',
      '.reserve{fill:var(--amber)}.pointer{stroke:var(--amber);stroke-width:2}',
      '.arrow{fill:none;stroke:var(--muted);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body,
  });
}
