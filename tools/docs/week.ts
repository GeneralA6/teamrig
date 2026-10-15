/**
 * The README's never-runs-out picture: one week of token use between two resets. First the unplanned week: usage
 * climbs too fast, hits the weekly limit on Thursday and waits there for the reset. Then teamrig's week: a "now" line
 * sweeps across, usage climbs evenly to 99.5%, each day's tasks turn done as it passes, and deploys pause in the last
 * hours before the reset. One 15 s CSS loop and no script; with motion turned off it is a still of the finished week.
 * It follows the reader's light or dark colour scheme.
 */
import { renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 300;

/** 15 s a loop; the parts hide at 14.6 s; the still shows 13.8 s, when the week is over. */
export const WEEK_CLOCK: Clock = { loop: 15, end: 14.6, rest: 13.8 };

/** When the "now" line starts across the week, and how long it takes. */
export const WEEK_SWEEP = { from: 3.8, duration: 8 } as const;

/** Where the chart sits: the week's left edge, a day's width, the limit's and the zero line's heights. */
const WEEK = { x0: 60, day: 120, top: 50, base: 230, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } as const;
/** The part of each day the team works, as shares of the day. */
const WORK = { start: 0.25, end: 0.8 } as const;
/** Deploys pause this share of a day before the reset: 4 hours. */
const PAUSE = 4 / 24;

/** teamrig's week spends 99.5% of the limit, the plan picture's fill, a seventh of it each day; the unplanned week spends 2.2 times that pace. */
export const PLANNED_PER_DAY = 0.995 / 7;
export const RUSHED_PER_DAY = 2.2 / 7;

/** A point on the chart, in pixels. */
type Point = readonly [x: number, y: number];

/** The share of the weekly limit used after `days`, when each day spends `perDay` evenly over its working hours; capped at the limit. */
export function used(days: number, perDay: number): number {
  const whole = Math.floor(days);
  const today = Math.min(Math.max((days - whole - WORK.start) / (WORK.end - WORK.start), 0), 1);
  return Math.min((whole + today) * perDay, 1);
}

const weekX = (days: number): number => WEEK.x0 + days * WEEK.day;
const weekY = (share: number): number => WEEK.base - (WEEK.base - WEEK.top) * share;

/** The day `x` falls in, from 0 (Monday). */
export const dayAt = (x: number): number => Math.floor((x - WEEK.x0) / WEEK.day);

/** The usage line over the week, one point every `step` days. */
function weekPath(perDay: number, step: number): Point[] {
  const points: Point[] = [];
  for (let k = 0; k * step <= 7 + 1e-9; k += 1) points.push([weekX(k * step), weekY(used(k * step, perDay))]);
  return points;
}

const pathOf = (points: readonly Point[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

/** The line's length through every point, in pixels. */
function lengthOf(points: readonly Point[]): number {
  let length = 0;
  let previous: Point | undefined;
  for (const point of points) {
    if (previous !== undefined) length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return length;
}

/**
 * The unplanned week: where it first reaches the limit, and its line up to there and then flat along the limit to the
 * reset. Throws if it never reaches the limit.
 */
export function rushedWeek(): { readonly hit: Point; readonly line: readonly Point[] } {
  const rushed = weekPath(RUSHED_PER_DAY, 1 / 48);
  const hit = rushed.find(([, y]) => y <= WEEK.top + 1e-9);
  if (hit === undefined) throw new RangeError('the unplanned week never reaches the limit');
  return { hit, line: [...rushed.filter(([x]) => x < hit[0]), hit, [weekX(7), WEEK.top]] };
}

/**
 * teamrig's week: the usage line draws behind the moving "now" line, and each day's area fills in once the day is
 * over. Nothing covers the line in the page's colour, since GitHub has more than one dark background.
 */
function plannedWeek(t: Timeline): string[] {
  const planned = weekPath(PLANNED_PER_DAY, 1 / 12);
  const dayEnd = (d: number): number => WEEK_SWEEP.from + (WEEK_SWEEP.duration * (d + 1)) / WEEK.days.length;
  const out = WEEK.days.map((_, d) => {
    const day = planned.filter(([x]) => x >= weekX(d) - 1e-9 && x <= weekX(d + 1) + 1e-9);
    return `<path d="${pathOf(day)}L${weekX(d + 1)} ${WEEK.base}L${weekX(d)} ${WEEK.base}Z" class="area ${t.show(dayEnd(d) - 0.1, { motion: 'fade' })}"/>`;
  });
  const length = Math.ceil(lengthOf(planned));
  out.push(
    `<path d="${pathOf(planned)}" stroke-dasharray="${length}" class="usage ${t.draw(WEEK_SWEEP.from, length, { duration: WEEK_SWEEP.duration })}"/>`,
    `<g class="${t.sweep(WEEK_SWEEP.from, WEEK_SWEEP.duration, weekX(7) - WEEK.x0)}"><path d="M${WEEK.x0} ${WEEK.top - 14}V${WEEK.base + 32}" class="now"/></g>`,
  );
  return out;
}

/** The frame: the resets at both ends, the limit, the deploy pause and the days. */
function frame(): string[] {
  const right = weekX(7);
  const pauseX = weekX(7 - PAUSE);
  return [
    `<rect x="${pauseX}" y="${WEEK.top}" width="${right - pauseX}" height="${WEEK.base - WEEK.top}" fill="url(#hatch)"/>`,
    `<text x="${pauseX - 8}" y="${WEEK.base - 14}" text-anchor="end" class="note">deploys pause</text>`,
    `<path d="M${WEEK.x0} ${WEEK.top}H${right}" class="limit"/>`,
    `<text x="${WEEK.x0 + 6}" y="${WEEK.top - 8}" class="note">your weekly token limit</text>`,
    `<path d="M${WEEK.x0} ${WEEK.base}H${right}" class="axis"/>`,
    ...[WEEK.x0, right].flatMap((x) => [
      `<path d="M${x} ${WEEK.top - 14}V${WEEK.base + 32}" class="axis"/>`,
      `<text x="${x}" y="${WEEK.top - 22}" text-anchor="middle" class="note">reset</text>`,
    ]),
    ...WEEK.days.map((day, i) => `<text x="${weekX(i + 0.5)}" y="${WEEK.base + 56}" text-anchor="middle" class="day">${day}</text>`),
  ];
}

/** Each day's three tasks: planned outlines that turn done as the "now" line passes them. */
function tasks(t: Timeline): string[] {
  const right = weekX(7);
  return WEEK.days.flatMap((_, d) =>
    [0, 1, 2].flatMap((k) => {
      const x = weekX(d) + 6 + k * 32;
      const doneAt = WEEK_SWEEP.from + (WEEK_SWEEP.duration * (x + 26 - WEEK.x0)) / (right - WEEK.x0);
      return [
        `<rect x="${x + 0.5}" y="${WEEK.base + 12.5}" width="25" height="11" rx="3" class="task"/>`,
        `<rect x="${x}" y="${WEEK.base + 12}" width="26" height="12" rx="3" class="done ${t.show(doneAt, { motion: 'fade' })}"/>`,
      ];
    }),
  );
}

/** The unplanned week, drawn first: it hits the limit on Thursday and waits there for the reset. */
function unplannedWeek(t: Timeline): string[] {
  const { hit, line } = rushedWeek();
  const length = Math.ceil(lengthOf(line));
  return [
    `<path d="${pathOf(line)}" stroke-dasharray="${length}" class="rushed ${t.draw(0.6, length, { duration: 2.4 })}"/>`,
    `<circle cx="${hit[0]}" cy="${hit[1]}" r="5" class="hit ${t.pop(1.7)}"/>`,
    `<text x="${hit[0] + 14}" y="${WEEK.top - 8}" class="note strong ${t.show(2.0)}">Without a plan: out of tokens by Thursday</text>`,
  ];
}

/** The result, once the "now" line reaches the reset. */
function result(t: Timeline): string[] {
  const x = weekX(7) - 32;
  return [
    `<g class="${t.show(WEEK_SWEEP.from + WEEK_SWEEP.duration + 0.2)}">`,
    `<text x="${x}" y="${WEEK.top + 86}" text-anchor="end" class="result"><tspan class="brand">With teamrig:</tspan> 99.5% used,</text>`,
    `<text x="${x}" y="${WEEK.top + 108}" text-anchor="end" class="result">every task done before the reset.</text>`,
    `</g>`,
  ];
}

/** The picture as an SVG file. */
export function renderWeek(): string {
  const t = new Timeline(WEEK_CLOCK);
  // The parts are drawn in this order so the animation classes are numbered as in the approved draft.
  const body = [...plannedWeek(t), ...frame(), ...tasks(t), ...unplannedWeek(t), ...result(t)];
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label:
      'A week of token use between two resets. Without a plan, usage climbs too fast, hits the weekly limit on Thursday, ' +
      'and work waits for the reset. With teamrig, the work is spread over the week: usage climbs evenly to 99.5%, each ' +
      "day's tasks get done, and deploys pause in the last hours before the reset.",
    style: [
      ...themeStyle(),
      '.note{font-size:13px;fill:var(--muted)}.note.strong{fill:var(--fg)}.day{font-size:14px;fill:var(--muted)}',
      '.result{font-size:16px;font-weight:600}.brand{fill:var(--purple)}',
      '.area{fill:var(--purple);fill-opacity:.12}.usage{fill:none;stroke:var(--purple);stroke-width:2.6;stroke-linejoin:round}',
      '.now{stroke:var(--purple);stroke-width:1.4;stroke-opacity:.7}',
      '.limit{stroke:var(--fg);stroke-width:1.4;stroke-dasharray:6 5;stroke-opacity:.55}.axis{stroke:var(--line);stroke-width:1.2}',
      '.hatch{stroke:var(--line);stroke-width:1.4}',
      '.task{fill:none;stroke:var(--line)}.done{fill:var(--green)}',
      '.rushed{fill:none;stroke:var(--muted);stroke-width:2;stroke-linejoin:round}.hit{fill:var(--fg)}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body: [
      '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V7" class="hatch"/></pattern></defs>',
      ...body,
    ],
  });
}
