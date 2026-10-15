import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, mix } from './colour.ts';
import {
  BACKLOG,
  barX,
  layOut,
  PLAN_CLOCK,
  PLAN_FILL,
  PLAN_STEPS,
  planWeek,
  PRIORITIES,
  PRIORITY_SHADE,
  renderPlan,
  RESETS,
  type PlanTask,
} from './plan.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { FADE } from './timeline.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderPlan();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);
const EMPTY = parseXml('<g/>');

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');
const animationOf = (element: XmlElement): string => classesOf(element).find((name) => /^a\d+$/.test(name)) ?? '';
const step = (name: string): XmlElement => places.find((place) => place.element.attributes.get('data-step') === name)?.element ?? EMPTY;
const wordsIn = (element: XmlElement): string[] =>
  placesIn(element)
    .filter((place) => place.element.name === 'text')
    .map((place) => textOf(place.element));

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

/** An animation's keyframe stops in seconds: hidden until [1], shown from [2] to [3], hidden again from [4]. */
const secondsOf = (name: string): number[] => (frames.get(name)?.stops ?? []).map((stop) => (stop * PLAN_CLOCK.loop) / 100);
const close = (a: number | undefined, b: number | undefined): boolean => a !== undefined && b !== undefined && Math.abs(a - b) < 0.01;

const task = (title: string, priority: PlanTask['priority'], estimate: number): PlanTask => ({ title, priority, estimate });

describe('renderPlan', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderPlan(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /^Your lead plans the week from the tokens you have left\. The tasks fill the days, most important first/);
    assert.match(label, /until the plan reaches 99\.5% of your weekly limit\. The last 0\.5% is kept for incidents/);
    assert.match(label, /the task that doesn't fit moves to next week\.$/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.equal(animated.size, 7);
    for (const [selector, name] of animated) {
      const stops = frames.get(name)?.stops ?? [];
      assert.ok(ascending(stops), `${selector}: ${stops.join(' ')}`);
      assert.deepEqual([stops[0], stops.at(-1)], [0, 100], selector);
    }
  });

  it('stops all motion when the reader asks for reduced motion', () => {
    assert.equal(mediaIn(css).get('(prefers-reduced-motion:reduce)'), '*{animation:none!important}');
  });

  it('shows the steps in order: the tokens, the caption and the tasks one by one, the reserve, then next week', () => {
    const tasks = placesIn(step('tasks')).filter((place) => place.element.attributes.has('data-task'));
    const caption = placesIn(step('tasks')).find((place) => place.element.name === 'text')?.element ?? EMPTY;
    const parts = [step('tokens'), caption, ...tasks.map((place) => place.element), step('reserve'), step('next-week')];
    const shown = parts.map((part) => secondsOf(animationOf(part))[1]);
    const expected = [PLAN_STEPS.tokens, PLAN_STEPS.tasks, ...tasks.map((_, i) => PLAN_STEPS.tasks + i * PLAN_STEPS.taskStep), PLAN_STEPS.reserve, PLAN_STEPS.nextWeek];
    assert.equal(tasks.length, 3);
    for (const [i, time] of shown.entries()) assert.ok(close(time, expected[i]), `part ${i}: ${time}`);
  });

  it('holds the finished plan for at least 5 s, then fades it all out together so the loop starts empty', () => {
    for (const [selector, name] of animationsIn(css)) {
      const seconds = secondsOf(name);
      assert.ok(close(seconds[3], PLAN_CLOCK.end - FADE) && close(seconds[4], PLAN_CLOCK.end), `${selector}: ${seconds.join(' ')}`);
    }
    assert.ok(PLAN_CLOCK.end - FADE - (PLAN_STEPS.nextWeek + FADE) >= 5);
  });

  it('shows the finished plan in its still picture, every step with its words', () => {
    for (const name of ['tokens', 'tasks', 'reserve', 'next-week']) {
      const found = places.find((place) => place.element.attributes.get('data-step') === name);
      assert.ok(found !== undefined, name);
      for (const part of placesIn(found.element)) assert.ok(still({ element: part.element, path: [...found.path, ...part.path] }), name);
    }
    assert.deepEqual(wordsIn(step('tasks')), [
      'Tasks fill the days, most important first, up to 99.5%',
      'Signup flow',
      'p1 · 45%',
      'Profile page',
      'p2 · 32%',
      'Dark mode',
      'p3 · 22.5%',
    ]);
    assert.deepEqual(wordsIn(step('reserve')), ['0.5% kept for incidents']);
    assert.deepEqual(wordsIn(step('next-week')), ['Moves to next week', 'Export', 'p4 · 9%']);
  });

  it('draws the week from reset to reset, a day to a column', () => {
    assert.deepEqual(wordsIn(step('tokens')), ['Tokens for this week', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'reset', 'reset']);
    const resets = placesIn(step('tokens')).filter((place) => place.element.name === 'text' && textOf(place.element) === 'reset');
    assert.deepEqual(
      resets.map((place) => Number(place.element.attributes.get('x'))),
      [...RESETS],
    );
  });

  it('keeps the reserve in amber, from the end of the last task to the right reset', () => {
    const plan = planWeek(BACKLOG, PLAN_FILL);
    const bar = placesIn(step('reserve')).find((place) => place.element.name === 'rect')?.element ?? EMPTY;
    const x = Number(bar.attributes.get('x'));
    assert.ok(Math.abs(x - barX(plan.used)) < 0.05);
    assert.ok(Math.abs(x + Number(bar.attributes.get('width')) - RESETS[1]) < 0.05);
    assert.equal(valueOf(rules.get('.reserve') ?? '', 'fill'), 'var(--amber)');
  });

  it('opens its stylesheet with the theme, and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it("keeps a task's words readable on its priority's tint, in the light and the dark theme", () => {
    for (const side of [0, 1] as const) {
      for (const priority of PRIORITIES) {
        const tint = mix(TOKENS.purple[side], TOKENS.bg[side], PRIORITY_SHADE[priority]);
        assert.ok(contrast(TOKENS.fg[side], tint) >= 4.5, `${priority} on side ${side}`);
      }
    }
    for (const priority of PRIORITIES) assert.equal(valueOf(rules.get(`.${priority}`) ?? '', 'fill-opacity'), String(PRIORITY_SHADE[priority]));
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});

describe('planWeek', () => {
  it("fills the README's week to 99.5% with the p1, p2 and p3 tasks, and moves the p4 task to next week", () => {
    const plan = planWeek(BACKLOG, PLAN_FILL);
    assert.equal(plan.used, 99.5);
    assert.deepEqual(
      plan.planned.map((planned) => planned.priority),
      ['p1', 'p2', 'p3'],
    );
    assert.deepEqual(
      plan.nextWeek.map((waiting) => waiting.title),
      ['Export'],
    );
  });

  it('takes the tasks in priority order, keeping the backlog order within a priority', () => {
    const plan = planWeek([task('c', 'p3', 1), task('a1', 'p1', 1), task('b', 'p2', 1), task('a2', 'p1', 1)], 100);
    assert.deepEqual(
      plan.planned.map((planned) => planned.title),
      ['a1', 'a2', 'b', 'c'],
    );
  });

  it('moves a task that would pass the fill to next week, and still fits a smaller one after it', () => {
    const plan = planWeek([task('big', 'p1', 60), task('too big', 'p2', 50), task('small', 'p3', 30)], 99.5);
    assert.deepEqual(
      plan.planned.map((planned) => planned.title),
      ['big', 'small'],
    );
    assert.deepEqual(
      plan.nextWeek.map((waiting) => waiting.title),
      ['too big'],
    );
    assert.equal(plan.used, 90);
  });

  it('plans nothing from an empty backlog', () => {
    assert.deepEqual(planWeek([], PLAN_FILL), { planned: [], nextWeek: [], used: 0 });
  });
});

describe('layOut', () => {
  it('lays the planned tasks end to end from the left reset, each as wide as its share of the limit', () => {
    const [left, right] = RESETS;
    assert.deepEqual(
      layOut([task('a', 'p1', 50), task('b', 'p2', 25)]).map((block) => [block.x, block.width]),
      [
        [left, (right - left) / 2],
        [(left + right) / 2, (right - left) / 4],
      ],
    );
  });

  it("ends the README's plan 0.5% short of the right reset", () => {
    const last = layOut(planWeek(BACKLOG, PLAN_FILL).planned).at(-1);
    assert.ok(last !== undefined && Math.abs(last.x + last.width - barX(99.5)) < 1e-9);
    assert.ok(barX(99.5) < RESETS[1]);
  });
});
