import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { dayAt, PLANNED_PER_DAY, renderWeek, rushedWeek, used, WEEK_CLOCK, WEEK_SWEEP } from './week.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderWeek();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');
const withClass = (name: string): XmlPlace[] => places.filter((place) => classesOf(place.element).includes(name));
const animationOf = (place: XmlPlace): string => classesOf(place.element).find((name) => /^a\d+$/.test(name)) ?? '';

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

describe('renderWeek', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderWeek(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /^A week of token use between two resets\. Without a plan, usage climbs too fast, hits the weekly limit on Thursday/);
    assert.match(label, /usage climbs evenly to 99\.5%, each day's tasks get done, and deploys pause in the last hours before the reset\.$/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > 30, `only ${animated.size} animated classes`);
    for (const [selector, name] of animated) {
      const stops = frames.get(name)?.stops ?? [];
      assert.ok(ascending(stops), `${selector}: ${stops.join(' ')}`);
      assert.deepEqual([stops[0], stops.at(-1)], [0, 100], selector);
    }
  });

  it('uses every animation class it defines, and defines every one it uses', () => {
    const usedClasses = new Set(places.flatMap((place) => classesOf(place.element)).filter((name) => /^a\d+$/.test(name)));
    const defined = new Set([...rules.keys()].filter((selector) => /^\.a\d+$/.test(selector)).map((selector) => selector.slice(1)));
    assert.deepEqual([...usedClasses].sort(), [...defined].sort());
  });

  it('stops all motion when the reader asks for reduced motion', () => {
    assert.equal(mediaIn(css).get('(prefers-reduced-motion:reduce)'), '*{animation:none!important}');
  });

  it('turns each task done as the "now" line passes it, left to right, while the line crosses the week', () => {
    const marks = withClass('done').map((place) => ({
      x: Number(place.element.attributes.get('x')),
      at: ((frames.get(animationOf(place))?.stops[1] ?? 0) * WEEK_CLOCK.loop) / 100,
    }));
    assert.equal(marks.length, 21);
    assert.ok(ascending(marks.map((mark) => mark.x)) && ascending(marks.map((mark) => mark.at)));
    assert.ok(marks.every((mark) => mark.at > WEEK_SWEEP.from && mark.at <= WEEK_SWEEP.from + WEEK_SWEEP.duration));
  });

  describe('its still picture, which reduced motion shows: the finished week', () => {
    it('rests after the "now" line reaches the reset and before the loop clears', () => {
      assert.ok(WEEK_SWEEP.from + WEEK_SWEEP.duration < WEEK_CLOCK.rest && WEEK_CLOCK.rest < WEEK_CLOCK.end);
    });

    it('shows both weeks in full: every day filled, every task done, the unplanned line and where it ran out', () => {
      for (const cls of ['area', 'done', 'usage', 'rushed', 'hit']) {
        const found = withClass(cls);
        assert.ok(found.length > 0 && found.every(still), cls);
      }
      assert.equal(withClass('area').length, 7);
    });

    it('shows the "now" line at the reset, and the result', () => {
      const now = withClass('now')[0]?.path.at(-2);
      assert.equal(valueOf(rules.get(`.${classesOf(now)[0] ?? ''}`) ?? '', 'transform'), 'translateX(840px)');
      const words = places.filter((place) => place.element.name === 'text' && still(place)).map((place) => textOf(place.element));
      for (const line of ['Without a plan: out of tokens by Thursday', 'With teamrig: 99.5% used,', 'every task done before the reset.']) assert.ok(words.includes(line), line);
    });
  });

  it('opens its stylesheet with the theme, and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});

describe('used', () => {
  it('spends a day only in its working hours, and never more than the limit', () => {
    assert.equal(used(0.2, PLANNED_PER_DAY), 0);
    assert.equal(used(0.9, PLANNED_PER_DAY), PLANNED_PER_DAY);
    assert.ok(Math.abs(used(1.525, 0.1) - 0.15) < 1e-9);
    assert.equal(used(7, 1), 1);
  });

  it("ends teamrig's week at 99.5% of the limit", () => {
    assert.ok(Math.abs(used(7, PLANNED_PER_DAY) - 0.995) < 1e-9);
  });
});

describe('rushedWeek', () => {
  it('runs out of tokens on Thursday, then waits at the limit until the reset', () => {
    const { hit, line } = rushedWeek();
    assert.equal(dayAt(hit[0]), 3);
    assert.deepEqual(line.at(-1), [900, 50]);
    assert.ok(ascending(line.map(([x]) => x)));
  });
});
