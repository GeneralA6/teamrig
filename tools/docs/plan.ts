/**
 * The README's planning picture: the lead plans one week from the tokens left. Each task has a priority and a token
 * estimate; the lead fills the week in priority order, p1 first, until the plan reaches 99.5% of the weekly limit,
 * keeps the last 0.5% for incidents, and moves the tasks that do not fit to next week. Each member's tasks fill its
 * lane from one reset to the next. The plan builds up one priority at a time in one 12 s CSS loop and no script; with
 * motion turned off it is a still of the finished plan. It follows the reader's light or dark colour scheme.
 */
import { escapeXml, MONO_FONTS, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 284;

/** 12 s a loop; the parts hide at 11.6 s; the still shows 10.8 s, when the plan is finished. */
export const PLAN_CLOCK: Clock = { loop: 12, end: 11.6, rest: 10.8 };

/** When the first priority shows, and the time between one step of the build-up and the next. */
export const PLAN_BUILD = { from: 1, step: 1.2 } as const;

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MEMBERS = ['api', 'web', 'tests'] as const;
export type Member = (typeof MEMBERS)[number];

export interface PlanTask {
  readonly title: string;
  readonly member: Member;
  readonly priority: Priority;
  /** The token estimate, in percent of the weekly limit. */
  readonly estimate: number;
}

/** The share of the weekly limit the plan may fill, in percent; the rest is kept for incidents. */
export const PLAN_FILL = 99.5;

/** The team's tasks for the week, with the hero picture's members and p1 tasks. */
export const BACKLOG: readonly PlanTask[] = [
  { title: 'Signup endpoint', member: 'api', priority: 'p1', estimate: 14 },
  { title: 'Signup form', member: 'web', priority: 'p1', estimate: 12 },
  { title: 'End-to-end tests', member: 'tests', priority: 'p1', estimate: 9 },
  { title: 'Rate limits', member: 'api', priority: 'p2', estimate: 11 },
  { title: 'Profile page', member: 'web', priority: 'p2', estimate: 12 },
  { title: 'Load test', member: 'tests', priority: 'p2', estimate: 13 },
  { title: 'Billing API', member: 'api', priority: 'p3', estimate: 8.5 },
  { title: 'Dark mode', member: 'web', priority: 'p3', estimate: 9 },
  { title: 'Browser tests', member: 'tests', priority: 'p3', estimate: 11 },
  { title: 'Search', member: 'api', priority: 'p4', estimate: 12 },
  { title: 'Export', member: 'web', priority: 'p4', estimate: 7 },
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
    } else nextWeek.push(task);
  }
  return { planned, nextWeek, used };
}

/** Where the board sits: the week's left edge, a day's width, the first lane's top, a lane's height and the gap between lanes. */
const BOARD = { x0: 110, day: 84, top: 100, lane: 40, gap: 10, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } as const;
/** The reset at the week's end: the right edge of the board and of the token bar. */
const RIGHT = BOARD.x0 + BOARD.days.length * BOARD.day;
const BOTTOM = BOARD.top + MEMBERS.length * (BOARD.lane + BOARD.gap) - BOARD.gap;
/** The token bar's top and height. */
const BAR = { top: 42, height: 18 } as const;
/** The next-week tray's left edge and card width. */
const TRAY = { x: RIGHT + 40, width: 168 } as const;

const laneTop = (row: number): number => BOARD.top + row * (BOARD.lane + BOARD.gap);
const barX = (percent: number): number => BOARD.x0 + ((RIGHT - BOARD.x0) * percent) / 100;
const percent = (value: number): string => `${Number(value.toFixed(1))}%`;
const sum = (tasks: readonly PlanTask[]): number => tasks.reduce((total, task) => total + task.estimate, 0);

/** A planned task's place on the board. */
export interface Block {
  readonly task: PlanTask;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** Each member's planned tasks, in order, across its lane from one reset to the next, as wide as their estimates. */
export function layOut(planned: readonly PlanTask[]): Block[] {
  return MEMBERS.flatMap((member, row) => {
    const tasks = planned.filter((task) => task.member === member);
    const scale = (RIGHT - BOARD.x0) / sum(tasks);
    let x = BOARD.x0;
    return tasks.map((task) => {
      const block = { task, x, y: laneTop(row), width: task.estimate * scale };
      x += block.width;
      return block;
    });
  });
}

/** The frame: the token bar's track and limit, the members' lanes, the resets at both ends and the days. */
function frame(): string[] {
  return [
    `<text x="${BOARD.x0}" y="${BAR.top - 12}" class="note">Tokens left this week</text>`,
    `<text x="${RIGHT}" y="${BAR.top - 12}" text-anchor="end" class="note">your weekly limit</text>`,
    `<rect x="${BOARD.x0}" y="${BAR.top}" width="${RIGHT - BOARD.x0}" height="${BAR.height}" rx="3" class="track"/>`,
    `<path d="M${RIGHT} ${BAR.top - 8}V${BAR.top + BAR.height + 8}" class="limit"/>`,
    ...MEMBERS.map((member, row) => `<text x="${BOARD.x0 - 14}" y="${laneTop(row) + 25}" text-anchor="end" class="who">${member}</text>`),
    `<path d="M${BOARD.x0} ${BOTTOM + 8}H${RIGHT}" class="axis"/>`,
    ...BOARD.days.slice(1).map((_, d) => `<path d="M${BOARD.x0 + (d + 1) * BOARD.day} ${BOTTOM + 8}v6" class="axis"/>`),
    ...[BOARD.x0, RIGHT].flatMap((x) => [
      `<path d="M${x} ${BOARD.top - 6}V${BOTTOM + 14}" class="axis"/>`,
      `<text x="${x}" y="${BOTTOM + 30}" text-anchor="middle" class="note">reset</text>`,
    ]),
    ...BOARD.days.map((day, d) => `<text x="${BOARD.x0 + (d + 0.5) * BOARD.day}" y="${BOTTOM + 30}" text-anchor="middle" class="day">${day}</text>`),
  ];
}

/** A task as a card, its title over its priority and estimate: tinted by priority in the week, dashed and muted when it waits. */
function card(task: PlanTask, x: number, y: number, width: number, waits: boolean): string[] {
  const words = waits ? ' later-words' : '';
  return [
    `<rect x="${(x + 1.5).toFixed(1)}" y="${y}" width="${(width - 3).toFixed(1)}" height="${BOARD.lane}" rx="4" class="${waits ? 'later' : task.priority}"/>`,
    `<text x="${(x + 11).toFixed(1)}" y="${y + 17}" class="title${words}">${escapeXml(task.title)}</text>`,
    `<text x="${(x + 11).toFixed(1)}" y="${y + 33}" class="est${words}">${task.priority} · ${percent(task.estimate)}</text>`,
  ];
}

/** One priority's step of the build-up: its share of the token bar, labelled, and its tasks on the board. */
function priorityStep(priority: Priority, plan: WeekPlan, blocks: readonly Block[], at: number, t: Timeline): string[] {
  const before = sum(plan.planned.slice(0, plan.planned.findIndex((task) => task.priority === priority)));
  const share = sum(plan.planned.filter((task) => task.priority === priority));
  const [left, right] = [barX(before), barX(before + share)];
  return [
    `<g data-step="${priority}" class="${t.show(at, { motion: 'fade' })}">`,
    `<rect x="${left.toFixed(1)}" y="${BAR.top}" width="${(right - left).toFixed(1)}" height="${BAR.height}" class="${priority}"/>`,
    `<text x="${((left + right) / 2).toFixed(1)}" y="${BAR.top + BAR.height + 18}" text-anchor="middle" class="note">${priority} tasks ${percent(share)}</text>`,
    ...blocks.filter((block) => block.task.priority === priority).flatMap((block) => card(block.task, block.x, block.y, block.width, false)),
    `</g>`,
  ];
}

/** The plan's total and the reserve, beside the end of the token bar. */
function totals(plan: WeekPlan, at: number, t: Timeline): string[] {
  const x = RIGHT + 16;
  return [
    `<g data-step="totals" class="${t.show(at, { motion: 'fade' })}">`,
    `<text x="${x}" y="${BAR.top + 6}" class="note strong">${percent(plan.used)} planned,</text>`,
    `<text x="${x}" y="${BAR.top + 24}" class="note">${percent(100 - plan.used)} kept for incidents</text>`,
    `</g>`,
  ];
}

/** The tasks that did not fit, past the reset, one to a lane. */
function nextWeek(plan: WeekPlan, at: number, t: Timeline): string[] {
  return [
    `<g data-step="next-week" class="${t.show(at, { motion: 'fade' })}">`,
    `<text x="${TRAY.x}" y="${BOARD.top - 10}" class="note strong">Moves to next week</text>`,
    ...plan.nextWeek.flatMap((task, row) => card(task, TRAY.x - 1.5, laneTop(row), TRAY.width, true)),
    `</g>`,
  ];
}

/** The picture as an SVG file. */
export function renderPlan(): string {
  const plan = planWeek(BACKLOG, PLAN_FILL);
  const t = new Timeline(PLAN_CLOCK);
  const blocks = layOut(plan.planned);
  const steps = PRIORITIES.filter((priority) => plan.planned.some((task) => task.priority === priority));
  const at = (step: number): number => PLAN_BUILD.from + step * PLAN_BUILD.step;
  const body = [
    ...frame(),
    ...steps.flatMap((priority, step) => priorityStep(priority, plan, blocks, at(step), t)),
    ...totals(plan, at(steps.length), t),
    ...nextWeek(plan, at(steps.length + 1), t),
  ];
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label:
      'Your lead plans the week from the tokens you have left. It sizes each task in tokens and fills the week in order ' +
      `of priority, p1 first, until the plan reaches ${percent(plan.used)} of your weekly limit, keeping ` +
      `${percent(100 - plan.used)} for incidents. Each member's tasks fill its lane from one reset to the next, and the ` +
      'tasks that do not fit move to next week.',
    style: [
      ...themeStyle(),
      '.note{font-size:13px;fill:var(--muted)}.note.strong{fill:var(--fg);font-weight:600}.day{font-size:14px;fill:var(--muted)}',
      `.who{font-family:${MONO_FONTS};font-size:14px}.title{font-size:13px;font-weight:600}.est{font-size:12px}`,
      ...PRIORITIES.map((priority) => `.${priority}{fill:var(--purple);fill-opacity:${PRIORITY_SHADE[priority]}}`),
      '.later{fill:none;stroke:var(--muted);stroke-width:1.2;stroke-dasharray:5 4}.later-words{fill:var(--muted)}',
      '.track{fill:none;stroke:var(--line);stroke-width:1.2}.axis{stroke:var(--line);stroke-width:1.2}',
      '.limit{stroke:var(--fg);stroke-width:1.4;stroke-dasharray:4 3;stroke-opacity:.55}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body,
  });
}
