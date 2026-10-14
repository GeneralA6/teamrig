/**
 * The README's growth picture: how a teamrig team grows. A camera pulls back from the lead as time passes (Day 1,
 * Week 2, Month 2, Month 6); at each step more people pop in at the edges, lines draw out to them, and members whose
 * job is done turn to dashed outlines and move on. One 20 s CSS loop and no script; with motion turned off it is a
 * still of Month 6. It follows the reader's light or dark colour scheme. The layout is checked as it is drawn: a
 * person off screen, two people overlapping or a line through a person throws.
 */
import { escapeXml, renderSvg } from './svg.ts';
import { themeStyle } from './theme.ts';
import { Timeline, type Clock } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 420;

/** 20 s a loop; the parts hide at 18.8 s; the still shows 18.3 s, Month 6 with everyone in. */
export const GROWTH_CLOCK: Clock = { loop: 20, end: 18.8, rest: 18.3 };

type Kind = 'you' | 'lead' | 'core' | 'sublead' | 'member';

/** Size per kind, in world units. Kinds that join when the camera is further out are drawn bigger, so they read when they appear. */
const LOOK: Readonly<Record<Kind, { readonly font: number; readonly h: number; readonly stroke: number; readonly edge: number }>> = {
  you: { font: 16, h: 38, stroke: 1.6, edge: 2.2 },
  lead: { font: 16, h: 38, stroke: 1.6, edge: 2.2 },
  core: { font: 15, h: 36, stroke: 1.6, edge: 2.2 },
  sublead: { font: 22, h: 48, stroke: 2.6, edge: 3.4 },
  member: { font: 18, h: 38, stroke: 2.2, edge: 3 },
};

/** The colour class per kind: you, a lead (the lead and each team's lead), or a member. */
const TONE: Readonly<Record<Kind, 'you' | 'lead' | 'member'>> = { you: 'you', lead: 'lead', core: 'member', sublead: 'lead', member: 'member' };

export interface Person {
  readonly label: string;
  readonly kind: Kind;
  /** Where the person sits, in world units around the lead. */
  readonly x: number;
  readonly y: number;
  /** When the person pops in; the line from its parent is drawn just before. */
  readonly from: number;
  readonly parent?: Person;
  /** When its job is done: it turns into a dashed outline that fades, with `tag` under it if given. */
  readonly leaves?: number;
  readonly tag?: string;
}

/** A camera move: at `at` it eases to `scale` over `duration` seconds. */
export interface Zoom {
  readonly at: number;
  readonly duration: number;
  readonly scale: number;
}

interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** A line is drawn this long before its person pops in. */
const DRAW = 0.35;
/** How long a leaving person's dashed outline stays. */
const GHOST = 1.3;
/** Where the lead sits on screen. */
const CAMERA = { x: 480, y: 258 } as const;
/** The scene's screen area, under the chapter text. */
const VIEW: Box = { x1: 8, y1: 92, x2: 952, y2: 414 };

/** The camera pulls back three times: Week 2, Month 2 and Month 6. */
export const ZOOMS: readonly Zoom[] = [
  { at: 4.2, duration: 1.0, scale: 0.78 },
  { at: 8.1, duration: 1.0, scale: 0.56 },
  { at: 12.3, duration: 1.0, scale: 0.42 },
];

const widthOf = (p: Person): number => {
  const { font } = LOOK[p.kind];
  return Math.round(Math.max(p.label.length * font * 0.6 + font * 1.7, font * 5.4));
};

function boxOf(p: Person, pad = 0): Box {
  const w = widthOf(p) / 2 + pad;
  const h = LOOK[p.kind].h / 2 + pad;
  return { x1: p.x - w, y1: p.y - h, x2: p.x + w, y2: p.y + h };
}

/** When the person is on screen: from the start of its line to the end of its dashed outline (or the story's end). */
function span(p: Person): readonly [number, number] {
  return [p.from - DRAW, p.leaves === undefined ? GROWTH_CLOCK.end : p.leaves + GHOST];
}

/** The camera's scale from `time` on: a zoom still under way at `time` counts as not started, so the smallest wins. */
function scaleFrom(zooms: readonly Zoom[], time: number): number {
  let scale = 1;
  for (const zoom of zooms) if (time >= zoom.at + zoom.duration) scale = zoom.scale;
  return scale;
}

/** True when the straight line from `a` to `b` passes inside `box`, checked every 2 units. */
function crosses(a: Person, b: Person, box: Box): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
  for (let k = 0; k <= steps; k += 1) {
    const x = a.x + ((b.x - a.x) * k) / steps;
    const y = a.y + ((b.y - a.y) * k) / steps;
    if (x > box.x1 && x < box.x2 && y > box.y1 && y < box.y2) return true;
  }
  return false;
}

/**
 * Every way the picture could break: a person off screen at the camera's scale when it joins, two people on screen at
 * the same time overlapping, or a line through a person. People in the same spot take turns there, so they never clash.
 */
export function layoutErrors(people: readonly Person[], zooms: readonly Zoom[]): string[] {
  const errors: string[] = [];
  const meet = (a: Person, b: Person): boolean => {
    const [a1, a2] = span(a);
    const [b1, b2] = span(b);
    return a1 < b2 && b1 < a2;
  };
  const sameSpot = (a: Person, b: Person): boolean => a.x === b.x && a.y === b.y;
  for (const p of people) {
    const scale = scaleFrom(zooms, p.from - DRAW);
    const box = boxOf(p);
    const screen = [CAMERA.x + box.x1 * scale, CAMERA.y + box.y1 * scale, CAMERA.x + box.x2 * scale, CAMERA.y + box.y2 * scale] as const;
    if (screen[0] < VIEW.x1 || screen[1] < VIEW.y1 || screen[2] > VIEW.x2 || screen[3] > VIEW.y2) {
      errors.push(`${p.label} is off screen at scale ${scale}: ${screen.map(Math.round).join(',')}`);
    }
  }
  people.forEach((a, i) => {
    for (const b of people.slice(i + 1)) {
      if (sameSpot(a, b) || !meet(a, b)) continue;
      const [near, other] = [boxOf(a, 6), boxOf(b)];
      if (near.x1 < other.x2 && other.x1 < near.x2 && near.y1 < other.y2 && other.y1 < near.y2) errors.push(`${a.label} overlaps ${b.label}`);
    }
  });
  for (const p of people) {
    const parent = p.parent;
    if (parent === undefined) continue;
    for (const q of people) {
      if (q === p || q === parent || sameSpot(q, p) || !meet(p, q)) continue;
      if (crosses(parent, p, boxOf(q, 3))) errors.push(`the line ${parent.label} -> ${p.label} crosses ${q.label}`);
    }
  }
  return errors;
}

/** Which side of its lead a team sits: a column to the left or right, or a row underneath. */
type Side = 'left' | 'right' | 'down';

interface Seat {
  readonly label: string;
  /** The member's place in the team's column (left or right) or row (down); 0 is level with or under its lead. */
  readonly slot: number;
  /** When the member joins, if not with the rest of the team. */
  readonly from?: number;
  readonly leaves?: number;
}

/** A team lead under `parent`, and its members in a row under it or on an arc beside it (an arc, so no line runs through a member). */
function team(parent: Person, label: string, x: number, y: number, from: number, side: Side, seats: readonly Seat[]): Person[] {
  const sub: Person = { label, kind: 'sublead', x, y, from, parent };
  const place = (slot: number): { x: number; y: number } =>
    side === 'down' ? { x: x + slot * 130, y: y + 75 } : { x: x + (side === 'left' ? -1 : 1) * (210 - 15 * slot * slot), y: y + slot * 50 };
  return [sub, ...seats.map(({ slot, from: joins, ...seat }, j): Person => ({ ...seat, kind: 'member', ...place(slot), from: joins ?? from + 0.45 + j * 0.15, parent: sub }))];
}

const you: Person = { label: 'you', kind: 'you', x: 0, y: -92, from: 0.3 };
const lead: Person = { label: 'lead', kind: 'lead', x: 0, y: 0, from: 0.9, parent: you };
const core = (label: string, x: number, y: number, from: number, leaving: Pick<Person, 'leaves' | 'tag'> = {}): Person => ({ label, kind: 'core', x, y, from, parent: lead, ...leaving });

/** Everyone in the story, in the order they are drawn. */
export const PEOPLE: readonly Person[] = [
  you,
  lead,
  // Day 1 and week 2: one team; docs moves on when its job is done and design takes its place.
  core('api', -190, 96, 1.7),
  core('web', 0, 112, 2.0),
  core('docs', 190, 96, 2.3, { leaves: 6.6, tag: 'job done' }),
  core('tests', -300, 20, 5.6),
  core('auth', 300, 20, 5.9),
  core('design', 190, 96, 7.3),
  // Month 2: teams of teams. Month 6: more teams, bigger teams, and members coming and going.
  ...team(lead, 'payments lead', -560, -150, 9.45, 'left', [
    { label: 'billing', slot: -1 },
    { label: 'invoices', slot: 0, leaves: 15.8 },
    { label: 'refunds', slot: 1 },
    { label: 'fraud', slot: -2, from: 15.1 },
    { label: 'tax', slot: 0, from: 16.5 },
  ]),
  ...team(lead, 'search lead', -560, 150, 9.7, 'left', [
    { label: 'index', slot: -1 },
    { label: 'ranking', slot: 0 },
    { label: 'filters', slot: 1 },
    { label: 'suggest', slot: 2, from: 15.25 },
  ]),
  ...team(lead, 'mobile lead', 560, -150, 9.95, 'right', [
    { label: 'ios', slot: -1 },
    { label: 'android', slot: 0 },
    { label: 'sync', slot: 1, leaves: 16.1 },
    { label: 'push', slot: -2, from: 15.4 },
    { label: 'offline', slot: 1, from: 16.8 },
  ]),
  ...team(lead, 'quality lead', 560, 150, 10.2, 'right', [
    { label: 'e2e', slot: -1 },
    { label: 'perf', slot: 0, leaves: 16.4 },
    { label: 'security', slot: 1 },
    { label: 'review', slot: 2, from: 15.55 },
    { label: 'load', slot: 0, from: 17.1 },
  ]),
  ...team(lead, 'data lead', -300, -320, 13.65, 'left', [
    { label: 'pipeline', slot: -1 },
    { label: 'reports', slot: 0 },
    { label: 'exports', slot: 1 },
  ]),
  ...team(lead, 'growth lead', 300, -320, 13.9, 'right', [
    { label: 'onboarding', slot: -1 },
    { label: 'emails', slot: 0 },
    { label: 'pricing', slot: 1 },
  ]),
  ...team(lead, 'support lead', -260, 270, 14.15, 'down', [
    { label: 'tickets', slot: -1 },
    { label: 'chat', slot: 0 },
    { label: 'faq', slot: 1 },
  ]),
  ...team(lead, 'ops lead', 260, 270, 14.4, 'down', [
    { label: 'deploys', slot: -1 },
    { label: 'alerts', slot: 0 },
    { label: 'backups', slot: 1 },
  ]),
];

/** A person's pill and name, drawn at its world position; `tone` picks the colours. */
function pill(p: Person, tone: string): string {
  const w = widthOf(p);
  const { font, h, stroke } = LOOK[p.kind];
  return (
    `<rect x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" class="node ${tone}" style="stroke-width:${stroke}"/>` +
    `<text x="${p.x}" y="${(p.y + font * 0.36).toFixed(1)}" text-anchor="middle" class="label ${tone}" style="font-size:${font}px">${escapeXml(p.label)}</text>`
  );
}

/** The chapter titles over the scene, one at a time, each with its line. */
function chapters(t: Timeline, teams: number, members: number): string[] {
  const all: ReadonlyArray<readonly [number, number, string, string]> = [
    [0.3, 4.3, 'Day 1', 'You tell your lead what you want. It hires a team of three.'],
    [4.3, 8.2, 'Week 2', 'The work grows. New members join, and finished ones move on.'],
    [8.2, 12.4, 'Month 2', 'One team becomes teams of teams, each with its own lead.'],
    [12.4, GROWTH_CLOCK.end, 'Month 6', `${teams} teams and ${members} members. You still talk to one lead.`],
  ];
  return all.flatMap(([from, to, title, line]) => [
    `<g class="${t.show(from, { to })}">`,
    `<text x="480" y="44" text-anchor="middle" class="chapter">${escapeXml(title)}</text>`,
    `<text x="480" y="72" text-anchor="middle" class="sub">${escapeXml(line)}</text>`,
    `</g>`,
  ]);
}

/** The scene, in world units around the lead, inside the moving camera: lines first, then the dashed outlines, then people on top. */
function scene(t: Timeline): string[] {
  const lines: string[] = [];
  const ghosts: string[] = [];
  const marks: string[] = [];
  for (const p of PEOPLE) {
    const last = p.leaves === undefined ? GROWTH_CLOCK.end : p.leaves + 0.25;
    if (p.parent !== undefined) {
      const { x, y } = p.parent;
      const length = Math.ceil(Math.hypot(p.x - x, p.y - y)) + 1;
      const ends = `x1="${x}" y1="${y}" x2="${p.x}" y2="${p.y}"`;
      lines.push(`<line ${ends} class="edge ${t.draw(p.from - DRAW, length, { to: last })}" style="stroke-width:${LOOK[p.kind].edge};stroke-dasharray:${length}"/>`);
      if (p.leaves !== undefined) lines.push(`<line ${ends} class="edge gone ${t.show(p.leaves, { to: p.leaves + GHOST, motion: 'fade' })}" style="stroke-width:${LOOK[p.kind].edge}"/>`);
    }
    if (p.leaves !== undefined) {
      const tag = p.tag === undefined ? '' : `<text x="${p.x}" y="${p.y + LOOK[p.kind].h / 2 + 20}" text-anchor="middle" class="tag">${escapeXml(p.tag)}</text>`;
      ghosts.push(`<g class="${t.show(p.leaves, { to: p.leaves + GHOST, motion: 'fade' })}">${pill(p, 'gone')}${tag}</g>`);
    }
    marks.push(`<g class="${t.pop(p.from, { to: last })}">${pill(p, TONE[p.kind])}</g>`);
  }
  const camera = (scale: number): string => `translate(${CAMERA.x}px,${CAMERA.y}px) scale(${scale})`;
  const stops = ZOOMS.map((zoom) => ({ at: zoom.at, duration: zoom.duration, value: camera(zoom.scale) }));
  return [`<g class="${t.steps(camera(1), stops, 'transform-box:view-box;transform-origin:0 0;')}">`, ...lines, ...ghosts, ...marks, '</g>'];
}

/** The picture as an SVG file. Throws when the layout breaks (see layoutErrors). */
export function renderGrowth(): string {
  const errors = layoutErrors(PEOPLE, ZOOMS);
  if (errors.length > 0) throw new Error(`growth.svg layout:\n${errors.join('\n')}`);
  const stays = PEOPLE.filter((p) => p.leaves === undefined);
  const teams = stays.filter((p) => p.kind === 'sublead').length;
  const members = stays.filter((p) => p.kind === 'core' || p.kind === 'member').length;
  const t = new Timeline(GROWTH_CLOCK);
  // The parts are drawn in this order so the animation classes are numbered as in the approved draft.
  const body = [...chapters(t, teams, members), ...scene(t)];
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label:
      'How a teamrig team grows. Day 1: you tell your lead what you want, and it hires api, web and docs. ' +
      'Week 2: tests and auth join; docs moves on when its job is done, and design takes its place. ' +
      'Month 2: the team becomes teams of teams, with a payments lead, a search lead, a mobile lead and a quality lead, each with its own members. ' +
      `Month 6: ${teams} teams and ${members} members, with members joining and moving on, and you still talk to one lead.`,
    style: [
      ...themeStyle(),
      '.chapter{font-size:24px;font-weight:700}.sub{font-size:15px;fill:var(--muted)}',
      '.node.you{fill:var(--bg);stroke:var(--fg)}.node.lead{fill:var(--tint);stroke:var(--purple)}.node.member{fill:var(--tile);stroke:var(--line)}',
      '.node.gone{fill:var(--bg);stroke:var(--muted);stroke-dasharray:6 6}',
      '.label{font-weight:600}.label.lead{fill:var(--purple)}.label.gone{fill:var(--muted)}',
      '.edge{fill:none;stroke:var(--muted);stroke-opacity:.5}.edge.gone{stroke-dasharray:6 6}',
      '.tag{font-size:15px;font-weight:600;fill:var(--green)}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body,
  });
}
