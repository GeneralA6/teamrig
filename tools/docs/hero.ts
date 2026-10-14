/**
 * The README's hero: a Claude Code window, drawn as an animated SVG, where the user asks the lead for a signup flow,
 * says yes to the team it proposes, and watches three tabs open and three tasks go from open to done. One 17 s CSS
 * loop and no script, so GitHub shows it in an <img>. With motion turned off it is a still of the finished work.
 */
import { escapeXml, MONO_FONTS, renderSvg, SANS_FONTS } from './svg.ts';
import { Timeline, type Clock, type TypingSegment } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 460;

/** 17 s a loop; the parts hide at 15.8 s; the still shows 14.6 s, when every task is done. */
export const HERO_CLOCK: Clock = { loop: 17, end: 15.8, rest: 14.6 };

/** The monospace advance at 15px, which every typed text is forced to with textLength. */
export const CHAR_WIDTH = 9;

/** GitHub's dark palette: the window is dark in either theme, as a terminal is. */
const C = {
  bg: '#0d1117',
  bar: '#161b22',
  panel: '#11161d',
  card: '#0d1117',
  border: '#30363d',
  fg: '#e6edf3',
  muted: '#8b949e',
  faint: '#6e7681',
  lead: '#a371f7',
  amber: '#d29922',
  green: '#3fb950',
} as const;

interface Member {
  readonly name: string;
  readonly color: string;
  readonly job: string;
  readonly task: string;
  /** When the member starts its task, in seconds. */
  readonly start: number;
  /** When it finishes. */
  readonly done: number;
}

const TEAM: readonly Member[] = [
  { name: 'api', color: '#58a6ff', job: 'the signup endpoint', task: 'Signup endpoint', start: 8.2, done: 10.6 },
  { name: 'web', color: '#f778ba', job: 'the signup form', task: 'Signup form', start: 8.6, done: 11.4 },
  { name: 'tests', color: '#39c5cf', job: 'end-to-end tests', task: 'End-to-end tests', start: 9.0, done: 12.2 },
];

const ASK = 'Build a signup flow: an API, a web form and tests.';

/** What the user types into the input box, when, how fast, and when it is sent. */
interface Typing {
  readonly text: string;
  readonly from: number;
  readonly perChar: number;
  readonly sent: number;
}

/** The two things the user types: the ask, and the yes. */
export const HERO_TYPING: readonly Typing[] = [
  { text: ASK, from: 0.8, perChar: 0.044, sent: 3.3 },
  { text: 'yes', from: 5.6, perChar: 0.12, sent: 6.2 },
];

/** The task count over the loop: [from, to, label]. */
const PROGRESS: ReadonlyArray<readonly [number, number, string]> = [
  [0.2, 7.2, 'no tasks yet'],
  [7.2, 10.6, '0 of 3 done'],
  [10.6, 11.4, '1 of 3 done'],
  [11.4, 12.2, '2 of 3 done'],
  [12.2, 15.8, '3 of 3 done'],
];

const STORY =
  'A Claude Code window. In the lead tab, the user types: Build a signup flow: an API, a web form and tests. ' +
  'The lead proposes a team of three sessions, api, web and tests, and the user says yes. Three new tabs open and three tasks appear, ' +
  'one per session. Each task moves from open to in progress to done, and the lead reports: All 3 tasks done. Ready for your review.';

const tspan = (fill: string, text: string): string => `<tspan fill="${fill}">${escapeXml(text)}</tspan>`;
const prompt = (text: string): string => `<tspan fill="${C.faint}">&gt; </tspan>${tspan(C.fg, text)}`;

/** The window, its tab bar, the lead's tab and one tab per member, whose dot turns faint, amber, then green. */
function tabBar(t: Timeline): string[] {
  const out = [
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" fill="${C.bg}" stroke="${C.border}"/>`,
    `<path d="M1 13a12 12 0 0 1 12-12h${WIDTH - 26}a12 12 0 0 1 12 12v31h-${WIDTH - 2}z" fill="${C.bar}"/>`,
    `<path d="M12 44v-28a8 8 0 0 1 8-8h88a8 8 0 0 1 8 8v28z" fill="${C.bg}"/>`,
    `<circle cx="30" cy="27" r="4.5" fill="${C.lead}"/>`,
    `<text x="42" y="32" class="mono tab" fill="${C.fg}">lead</text>`,
  ];
  TEAM.forEach((member, i) => {
    const x = 124 + i * 100;
    const appear = 7.0 + i * 0.2;
    const dot = (fill: string, cls: string): string => `<circle cx="${x + 14}" cy="27" r="4.5" fill="${fill}" class="${cls}"/>`;
    const tab = t.show(appear);
    const waiting = dot(C.faint, t.show(appear, { to: member.start, motion: 'fade' }));
    const working = dot(C.amber, t.show(member.start, { to: member.done, motion: 'fade' }));
    const finished = dot(C.green, t.show(member.done, { motion: 'fade' }));
    out.push(`<g class="${tab}">`, waiting, working, finished, `<text x="${x + 26}" y="32" class="mono tab" fill="${C.muted}">${member.name}</text>`, `</g>`);
  });
  return out;
}

/** The talk in the lead's tab: the ask, the proposed team, the yes, and the lead's two reports. */
function conversation(t: Timeline): string[] {
  const out: string[] = [];
  const say = (y: number, from: number, body: string): void => {
    out.push(`<g class="${t.show(from)}"><text x="28" y="${y}" class="mono line">${body}</text></g>`);
  };
  say(84, 3.3, prompt(ASK));
  say(122, 3.9, tspan(C.fg, "I'll set up a team of three:"));
  TEAM.forEach((member, i) => {
    say(148 + i * 24, 4.2 + i * 0.25, `<tspan x="52" fill="${member.color}">${escapeXml(member.name)}</tspan><tspan x="124" fill="${C.muted}">${escapeXml(member.job)}</tspan>`);
  });
  say(230, 5.0, tspan(C.fg, 'You stay here as the lead. Start them?'));
  say(268, 6.2, prompt('yes'));
  say(306, 6.8, tspan(C.fg, 'Team signup is up: 3 tasks, 3 tabs open.'));
  say(344, 12.9, tspan(C.green, 'All 3 tasks done. Ready for your review.'));
  return out;
}

/**
 * The input box, where the user types. Each typed text is revealed by a cover sliding right one character at a
 * time; the caret rides the same steps.
 */
function inputBox(t: Timeline): string[] {
  const out = [
    `<defs><clipPath id="box"><rect x="44" y="392" width="540" height="40"/></clipPath></defs>`,
    `<rect x="28.5" y="386.5" width="563" height="51" rx="9" fill="${C.bg}" stroke="${C.border}"/>`,
    `<text x="44" y="419" class="mono line" fill="${C.faint}">&gt;</text>`,
    `<g clip-path="url(#box)">`,
  ];
  const segments = HERO_TYPING.map((typing): TypingSegment => {
    const chars = typing.text.length;
    const segment = { from: typing.from, duration: chars * typing.perChar, chars, reset: typing.sent };
    const width = chars * CHAR_WIDTH;
    out.push(
      `<g class="${t.show(typing.from - 0.05, { to: typing.sent, motion: 'fade' })}">`,
      `<text x="62" y="419" class="mono line" fill="${C.fg}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escapeXml(typing.text)}</text>`,
      `<rect x="61" y="398" width="${width + 12}" height="30" fill="${C.bg}" class="${t.slide([segment], CHAR_WIDTH)}"/>`,
      `</g>`,
    );
    return segment;
  });
  out.push(`<g class="${t.slide(segments, CHAR_WIDTH)}"><rect x="63" y="405" width="8" height="18" fill="${C.fg}" class="blink"/></g>`, `</g>`);
  return out;
}

/** The task board: the done count, a progress bar, and one card per task whose pill goes open, in progress, done. */
function taskBoard(t: Timeline): string[] {
  const out = [
    `<rect x="612.5" y="60.5" width="331" height="377" rx="10" fill="${C.panel}" stroke="${C.border}"/>`,
    `<text x="632" y="92" class="sans head" fill="${C.muted}">TASKS</text>`,
    `<rect x="632" y="106" width="292" height="4" rx="2" fill="${C.border}"/>`,
  ];
  for (const [from, to, label] of PROGRESS) {
    out.push(`<text x="924" y="92" text-anchor="end" class="sans small ${t.show(from, { to, motion: 'fade' })}" fill="${C.muted}">${label}</text>`);
  }
  TEAM.forEach((member, i) => {
    out.push(`<rect x="632" y="106" width="${((i + 1) * 292) / 3}" height="4" rx="2" fill="${C.green}" class="${t.show(member.done, { motion: 'fade' })}"/>`);
  });
  TEAM.forEach((member, i) => {
    const x = 632;
    const y = 126 + i * 90;
    const appear = 7.2 + i * 0.2;
    const pill = (label: string, width: number, color: string, filled: boolean, cls: string): string =>
      `<g class="${cls}"><rect x="${x + 276 - width}" y="${y + 44}" width="${width}" height="22" rx="11" fill="${filled ? color : 'none'}" fill-opacity="${filled ? 0.16 : 0}" stroke="${color}" stroke-opacity="${filled ? 0 : 0.8}"/>` +
      `<text x="${x + 276 - width / 2}" y="${y + 59}" text-anchor="middle" class="sans small" fill="${color}">${label}</text></g>`;
    const card = t.show(appear);
    out.push(
      `<g class="${card}">`,
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="291" height="77" rx="8" fill="${C.card}" stroke="${C.border}"/>`,
      `<text x="${x + 16}" y="${y + 30}" class="mono small" fill="${C.faint}">T${i + 1}</text>`,
      `<text x="${x + 48}" y="${y + 30}" class="sans title" fill="${C.fg}">${escapeXml(member.task)}</text>`,
      `<circle cx="${x + 20}" cy="${y + 55}" r="4" fill="${member.color}"/>`,
      `<text x="${x + 30}" y="${y + 60}" class="mono small" fill="${member.color}">${escapeXml(member.name)}</text>`,
      pill('open', 54, C.faint, false, t.show(appear, { to: member.start, motion: 'fade' })),
      pill('in progress', 96, C.amber, true, t.show(member.start, { to: member.done, motion: 'fade' })),
      pill('done', 56, C.green, true, t.show(member.done, { motion: 'fade' })),
      `</g>`,
    );
  });
  return out;
}

/** The hero as an SVG file. */
export function renderHero(): string {
  const t = new Timeline(HERO_CLOCK);
  // The parts are drawn in this order so the animation classes are numbered as in the approved draft.
  const body = [...tabBar(t), ...conversation(t), ...inputBox(t), ...taskBoard(t)];
  return renderSvg({
    width: WIDTH,
    height: HEIGHT,
    label: STORY,
    style: [
      `.mono{font-family:${MONO_FONTS}}.sans{font-family:${SANS_FONTS}}`,
      '.tab{font-size:14px}.line{font-size:15px}.small{font-size:12.5px}.title{font-size:15px;font-weight:600}.head{font-size:12px;font-weight:600;letter-spacing:.08em}',
      '@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}.blink{animation:blink 1.1s steps(1,end) infinite}',
      t.css(),
      '@media (prefers-reduced-motion:reduce){*{animation:none!important}}',
    ],
    body,
  });
}
