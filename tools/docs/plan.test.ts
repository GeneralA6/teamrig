import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, mix } from './colour.ts';
import {
  BACKLOG,
  layOut,
  MEMBERS,
  PLAN_BUILD,
  PLAN_CLOCK,
  PLAN_FILL,
  planWeek,
  PRIORITIES,
  PRIORITY_SHADE,
  renderPlan,
  type PlanTask,
} from './plan.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderPlan();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');
const animationOf = (element: XmlElement): string => classesOf(element).find((name) => /^a\d+$/.test(name)) ?? '';
const step = (name: string): XmlElement | undefined => places.find((place) => place.element.attributes.get('data-step') === name)?.element;
const wordsIn = (element: XmlElement | undefined): string[] =>
  placesIn(element ?? parseXml('<g/>'))
    .filter((place) => place.element.name === 'text')
    .map((place) => textOf(place.element));

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

/** When a build-up step starts to show, in seconds. */
const shownAt = (name: string): number => ((frames.get(animationOf(step(name) ?? parseXml('<g/>')))?.stops[1] ?? 0) * PLAN_CLOCK.loop) / 100;

const task = (title: string, priority: PlanTask['priority'], estimate: number): PlanTask => ({ title, member: 'api', priority, estimate });

describe('renderPlan', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderPlan(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /^Your lead plans the week from the tokens you have left\. It sizes each task in tokens/);
    assert.match(label, /until the plan reaches 99\.5% of your weekly limit, keeping 0\.5% for incidents\./);
    assert.match(label, /the tasks that do not fit move to next week\.$/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.equal(animated.size, 5);
    for (const [selector, name] of animated) {
      const stops = frames.get(name)?.stops ?? [];
      assert.ok(ascending(stops), `${selector}: ${stops.join(' ')}`);
      assert.deepEqual([stops[0], stops.at(-1)], [0, 100], selector);
    }
  });

  it('stops all motion when the reader asks for reduced motion', () => {
    assert.equal(mediaIn(css).get('(prefers-reduced-motion:reduce)'), '*{animation:none!important}');
  });

  it('builds the plan up one priority at a time, p1 first, then the total, then what moves to next week', () => {
    const order = ['p1', 'p2', 'p3', 'totals', 'next-week'];
    const times = order.map(shownAt);
    for (const [i, time] of times.entries()) assert.ok(Math.abs(time - (PLAN_BUILD.from + i * PLAN_BUILD.step)) < 0.01, order[i]);
    assert.ok(ascending(times) && (times.at(-1) ?? Infinity) < PLAN_CLOCK.rest);
  });

  it("gives each priority its share of the token bar and its tasks on the board, and nothing else's", () => {
    for (const priority of ['p1', 'p2', 'p3'] as const) {
      const tinted = placesIn(step(priority) ?? parseXml('<g/>')).filter((place) => place.element.name === 'rect');
      assert.equal(tinted.length, 4, priority);
      assert.ok(tinted.every((place) => classesOf(place.element).includes(priority)), priority);
    }
    assert.deepEqual(wordsIn(step('p1')), ['p1 tasks 35%', 'Signup endpoint', 'p1 · 14%', 'Signup form', 'p1 · 12%', 'End-to-end tests', 'p1 · 9%']);
  });

  it('shows the finished plan in its still picture: every step, the total, the reserve and next week', () => {
    for (const name of ['p1', 'p2', 'p3', 'totals', 'next-week']) {
      const found = places.find((place) => place.element.attributes.get('data-step') === name);
      assert.ok(found !== undefined && still(found), name);
    }
    assert.deepEqual(wordsIn(step('totals')), ['99.5% planned,', '0.5% kept for incidents']);
    assert.deepEqual(wordsIn(step('next-week')), ['Moves to next week', 'Search', 'p4 · 12%', 'Export', 'p4 · 7%']);
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
  it("fills the README's week to 99.5% with every p1, p2 and p3 task, and moves both p4 tasks to next week", () => {
    const plan = planWeek(BACKLOG, PLAN_FILL);
    assert.equal(plan.used, 99.5);
    assert.deepEqual([...new Set(plan.planned.map((planned) => planned.priority))], ['p1', 'p2', 'p3']);
    assert.deepEqual(
      plan.nextWeek.map((waiting) => waiting.title),
      ['Search', 'Export'],
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
  const blocks = layOut(planWeek(BACKLOG, PLAN_FILL).planned);
  /** The x of the drawn resets, at the week's start and end. */
  const [start = 0, end = 0] = places
    .filter((place) => place.element.name === 'text' && textOf(place.element) === 'reset')
    .map((place) => Number(place.element.attributes.get('x')));

  it("runs each member's tasks across its own lane from one reset to the next, end to end, p1 first", () => {
    const tops = new Set<number>();
    for (const member of MEMBERS) {
      const lane = blocks.filter((block) => block.task.member === member);
      assert.equal(lane.length, 3, member);
      assert.deepEqual(
        lane.map((block) => block.task.priority),
        ['p1', 'p2', 'p3'],
        member,
      );
      assert.equal(new Set(lane.map((block) => block.y)).size, 1, member);
      tops.add(lane[0]?.y ?? 0);
      assert.equal(lane[0]?.x, start, member);
      for (const [i, block] of lane.entries()) {
        const next = lane[i + 1];
        if (next !== undefined) assert.ok(Math.abs(block.x + block.width - next.x) < 1e-9, member);
      }
      const last = lane.at(-1);
      assert.ok(last !== undefined && Math.abs(last.x + last.width - end) < 1e-9, member);
    }
    assert.equal(tops.size, MEMBERS.length);
  });

  it("sizes the tasks in a lane by their token estimates", () => {
    const api = blocks.filter((block) => block.task.member === 'api');
    const [first, second] = api;
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(Math.abs(first.width / second.width - first.task.estimate / second.task.estimate) < 1e-9);
  });
});
