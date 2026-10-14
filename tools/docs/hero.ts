/**
 * The README's hero: a Claude Code window, drawn as an animated SVG, where the user asks the lead for a signup flow,
 * says yes to the team of three it offers to hire, and watches three tabs open and three tasks go to work. web stops
 * on a question, the lead brings it to the user (the talk scrolls up, as a terminal does), the user answers, and all
 * three tasks reach done. One 19.5 s CSS loop and no script, so GitHub shows it in an <img>. With motion turned off
 * it is a still of the finished work.
 */
import { escapeXml, MONO_FONTS, renderSvg, SANS_FONTS } from './svg.ts';
import { Timeline, type Clock, type TypingSegment } from './timeline.ts';

const WIDTH = 960;
const HEIGHT = 460;

/** 19.5 s a loop; the parts hide at 18.3 s; the still shows 17.4 s, when every task is done. */
export const HERO_CLOCK: Clock = { loop: 19.5, end: 18.3, rest: 17.4 };

/** The monospace advance at 15px, which every typed text is forced to with textLength. */
export const CHAR_WIDTH = 9;

/** When the talk scrolls up as web's question arrives, for how long, and how far in pixels. */
export const HERO_SCROLL = { at: 10.2, duration: 0.45, distance: 154 } as const;

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

/** A task's phase: open, in progress, waiting on the user's decision, or done. */
type Phase = 'open' | 'work' | 'ask' | 'done';

interface Member {
  readonly name: string;
  readonly job: string;
  readonly task: string;
  /** When the task enters each phase after `open`, in seconds, in order. */
  readonly phases: ReadonlyArray<readonly [Phase, number]>;
}

const TEAM: readonly Member[] = [
  { name: 'api', job: 'builds the signup endpoint', task: 'Signup endpoint', phases: [['work', 8.2], ['done', 10.4]] },
  { name: 'web', job: 'builds the signup form', task: 'Signup form', phases: [['work', 8.6], ['ask', 9.9], ['work', 13.6], ['done', 15.0]] },
  { name: 'tests', job: 'writes the end-to-end tests', task: 'End-to-end tests', phases: [['work', 9.0], ['done', 14.2]] },
];

/** How each phase looks: the member's tab dot takes its colour, and its task card shows the pill. */
const PHASE: Readonly<Record<Phase, { readonly label: string; readonly width: number; readonly color: string; readonly filled: boolean }>> = {
  open: { label: 'open', width: 54, color: C.faint, filled: false },
  work: { label: 'in progress', width: 96, color: C.amber, filled: true },
  ask: { label: 'needs you', width: 88, color: C.lead, filled: true },
  done: { label: 'done', width: 56, color: C.green, filled: true },
};

/** One phase of a task, shown from `from` until `to`. */
type Span = readonly [phase: Phase, from: number, to: number];

/** The task's phases as spans, starting open at `appear`; the last runs to the clock's end. */
function spans(member: Member, appear: number): Span[] {
  const starts: ReadonlyArray<readonly [Phase, number]> = [['open', appear], ...member.phases];
  return starts.map(([phase, from], i): Span => [phase, from, starts[i + 1]?.[1] ?? HERO_CLOCK.end]);
}

/** When the member's task reaches done, or the clock's end if it never does. */
const doneAt = (member: Member): number => member.phases.find(([phase]) => phase === 'done')?.[1] ?? HERO_CLOCK.end;

const ASK = 'Build a signup flow: an API, a web form and tests.';
const QUESTION = 'Should the form also offer Google sign-in?';
const ANSWER = 'Email only for now.';

/** What the user types into the input box, when, how fast, and when it is sent. */
interface Typing {
  readonly text: string;
  readonly from: number;
  readonly perChar: number;
  readonly sent: number;
}

/** The three things the user types: the ask, the yes, and the answer to web's question. */
export const HERO_TYPING: readonly Typing[] = [
  { text: ASK, from: 0.8, perChar: 0.044, sent: 3.3 },
  { text: 'yes', from: 5.6, perChar: 0.12, sent: 6.2 },
  { text: ANSWER, from: 11.5, perChar: 0.075, sent: 13.2 },
];

const STORY =
  'A Claude Code window. In the lead tab, the user types: Build a signup flow: an API, a web form and tests. ' +
  'The lead offers to hire a team of three, api, web and tests, and the user says yes. Three new tabs open and three tasks ' +
  'appear, one per member, and go to work. web stops on a question, and the lead brings it to the user: ' +
  `${QUESTION} The user answers: ${ANSWER} web goes back to work, all three tasks reach done, and the lead reports: ` +
  'All 3 tasks done. Ready for your review.';

const tspan = (fill: string, text: string): string => `<tspan fill="${fill}">${escapeXml(text)}</tspan>`;
const prompt = (text: string): string => `<tspan fill="${C.faint}">&gt; </tspan>${tspan(C.fg, text)}`;

/** The window, its tab bar, the lead's tab and one tab per member, whose dot takes its task's phase colour. */
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
    out.push(`<g class="${t.show(appear)}">`);
    for (const [phase, from, to] of spans(member, appear)) {
      out.push(`<circle cx="${x + 14}" cy="27" r="4.5" fill="${PHASE[phase].color}" class="${t.show(from, { to, motion: 'fade' })}"/>`);
    }
    out.push(`<text x="${x + 26}" y="32" class="mono tab" fill="${C.muted}">${escapeXml(member.name)}</text>`, `</g>`);
  });
  return out;
}

/**
 * The talk in the lead's tab: the ask, the team it offers to hire, the yes, web's question in a card, the answer,
 * and the lead's two reports. It scrolls up when the question arrives, inside a clip above the input box.
 */
function conversation(t: Timeline): string[] {
  const scroll = t.steps('translateY(0)', [{ at: HERO_SCROLL.at, duration: HERO_SCROLL.duration, value: `translateY(-${HERO_SCROLL.distance}px)` }]);
  const out = [
    `<defs><clipPath id="chat"><rect x="0" y="50" width="600" height="322"/></clipPath><clipPath id="box"><rect x="44" y="392" width="540" height="40"/></clipPath></defs>`,
    `<g clip-path="url(#chat)"><g class="${scroll}">`,
  ];
  const say = (y: number, from: number, body: string): void => {
    out.push(`<g class="${t.show(from)}"><text x="28" y="${y}" class="mono line">${body}</text></g>`);
  };
  say(84, 3.3, prompt(ASK));
  say(122, 3.9, tspan(C.fg, "I'll hire a team of three:"));
  TEAM.forEach((member, i) => {
    say(148 + i * 24, 4.2 + i * 0.25, `<tspan x="52" fill="${C.lead}">${escapeXml(member.name)}</tspan><tspan x="124" fill="${C.muted}">${escapeXml(member.job)}</tspan>`);
  });
  say(230, 5.0, tspan(C.fg, 'Shall I hire them?'));
  say(268, 6.2, prompt('yes'));
  say(306, 6.8, tspan(C.fg, 'Hired. 3 members, 3 tasks, all at work.'));
  out.push(
    `<g class="${t.pop(10.65, { overshoot: 1.04 })}">`,
    `<rect x="28.5" y="330.5" width="555" height="57" rx="8" fill="${C.lead}" fill-opacity="0.12" stroke="${C.lead}" stroke-opacity="0.6"/>`,
    `<text x="44" y="353" class="mono line"><tspan fill="${C.lead}">web</tspan><tspan fill="${C.muted}"> needs your decision:</tspan></text>`,
    `<text x="44" y="377" class="mono line" fill="${C.fg}">${escapeXml(QUESTION)}</text>`,
    `</g>`,
  );
  say(422, 13.2, prompt(ANSWER));
  say(460, 13.6, tspan(C.fg, 'Got it. web is back at work.'));
  say(498, 15.6, tspan(C.green, 'All 3 tasks done. Ready for your review.'));
  out.push('</g></g>');
  return out;
}

/**
 * The input box, where the user types. Each typed text is revealed by a cover sliding right one character at a
 * time; the caret rides the same steps.
 */
function inputBox(t: Timeline): string[] {
  const out = [
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

/** The task board: the done count, a progress bar, and one card per task whose pill shows its phase. */
function taskBoard(t: Timeline): string[] {
  const out = [
    `<rect x="612.5" y="60.5" width="331" height="377" rx="10" fill="${C.panel}" stroke="${C.border}"/>`,
    `<text x="632" y="92" class="sans head" fill="${C.muted}">TASKS</text>`,
    `<rect x="632" y="106" width="292" height="4" rx="2" fill="${C.border}"/>`,
  ];
  const finished = TEAM.map(doneAt).sort((a, b) => a - b);
  const counts = [7.2, ...finished].map((from, k, all): readonly [number, number, string] => [from, all[k + 1] ?? HERO_CLOCK.end, `${k} of ${TEAM.length} done`]);
  for (const [from, to, label] of [[0.2, 7.2, 'no tasks yet'] as const, ...counts]) {
    out.push(`<text x="924" y="92" text-anchor="end" class="sans small ${t.show(from, { to, motion: 'fade' })}" fill="${C.muted}">${label}</text>`);
  }
  finished.forEach((from, k) => {
    out.push(`<rect x="632" y="106" width="${((k + 1) * 292) / TEAM.length}" height="4" rx="2" fill="${C.green}" class="${t.show(from, { motion: 'fade' })}"/>`);
  });
  TEAM.forEach((member, i) => {
    const x = 632;
    const y = 126 + i * 90;
    const appear = 7.2 + i * 0.2;
    const pill = ([phase, from, to]: Span): string => {
      const look = PHASE[phase];
      return (
        `<g class="${t.show(from, { to, motion: 'fade' })}"><rect x="${x + 276 - look.width}" y="${y + 44}" width="${look.width}" height="22" rx="11" fill="${look.filled ? look.color : 'none'}" fill-opacity="${look.filled ? 0.16 : 0}" stroke="${look.color}" stroke-opacity="${look.filled ? 0 : 0.8}"/>` +
        `<text x="${x + 276 - look.width / 2}" y="${y + 59}" text-anchor="middle" class="sans small" fill="${look.color}">${look.label}</text></g>`
      );
    };
    out.push(
      `<g class="${t.show(appear)}">`,
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="291" height="77" rx="8" fill="${C.card}" stroke="${C.border}"/>`,
      `<text x="${x + 16}" y="${y + 30}" class="mono small" fill="${C.faint}">T${i + 1}</text>`,
      `<text x="${x + 48}" y="${y + 30}" class="sans title" fill="${C.fg}">${escapeXml(member.task)}</text>`,
      `<text x="${x + 16}" y="${y + 60}" class="mono small" fill="${C.lead}">${escapeXml(member.name)}</text>`,
      ...spans(member, appear).map(pill),
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
