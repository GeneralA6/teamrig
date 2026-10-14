import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GROWTH_CLOCK, layoutErrors, PEOPLE, renderGrowth, ZOOMS, type Person } from './growth.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderGrowth();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');
const animationOf = (element: XmlElement | undefined): string => classesOf(element).find((name) => /^a\d+$/.test(name)) ?? '';
/** When an animated class first changes, in seconds: its keyframes' second stop. */
const startOf = (element: XmlElement | undefined): number => ((frames.get(animationOf(element))?.stops[1] ?? Number.NaN) * GROWTH_CLOCK.loop) / 100;

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

/** The name labels in one tone (you, lead, member or gone). */
const labels = (tone: string): XmlPlace[] => places.filter((place) => place.element.name === 'text' && classesOf(place.element).join(' ') === `label ${tone}`);

const person = (label: string, x: number, y: number, extra: Partial<Person> = {}): Person => ({ label, kind: 'member', x, y, from: 1, ...extra });

describe('renderGrowth', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderGrowth(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /^How a teamrig team grows\. Day 1: you tell your lead what you want, and it hires api, web and docs\. /);
    assert.match(label, /Month 6: 8 teams and 33 members, with members joining and moving on, and you still talk to one lead\.$/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > 100, `only ${animated.size} animated classes`);
    for (const [selector, name] of animated) {
      const stops = frames.get(name)?.stops ?? [];
      assert.ok(ascending(stops), `${selector}: ${stops.join(' ')}`);
      assert.deepEqual([stops[0], stops.at(-1)], [0, 100], selector);
    }
  });

  it('uses every animation class it defines, and defines every one it uses', () => {
    const used = new Set(places.flatMap((place) => classesOf(place.element)).filter((name) => /^a\d+$/.test(name)));
    const defined = new Set([...rules.keys()].filter((selector) => /^\.a\d+$/.test(selector)).map((selector) => selector.slice(1)));
    assert.deepEqual([...used].sort(), [...defined].sort());
  });

  it('stops all motion when the reader asks for reduced motion', () => {
    assert.equal(mediaIn(css).get('(prefers-reduced-motion:reduce)'), '*{animation:none!important}');
  });

  it("draws each person's line before the person pops in", () => {
    const edges = places.filter((place) => place.element.name === 'line' && classesOf(place.element).join(' ').startsWith('edge a'));
    const pops = places.filter((place) => place.element.name === 'g' && place.element.children.some((node) => typeof node !== 'string' && node.name === 'rect') && !labels('gone').some((gone) => gone.path.includes(place.element)));
    const withParent = PEOPLE.filter((p) => p.parent !== undefined);
    assert.equal(edges.length, withParent.length);
    edges.forEach((edge, i) => {
      const popped = pops[PEOPLE.indexOf(withParent[i] ?? PEOPLE[0] ?? person('none', 0, 0))];
      assert.ok(Math.abs(startOf(popped?.element) - startOf(edge.element) - 0.35) < 0.01, withParent[i]?.label);
    });
  });

  describe('its still picture, which reduced motion shows: Month 6', () => {
    it('rests after the last person joins and the camera stops, and before the loop clears', () => {
      const last = Math.max(...PEOPLE.map((p) => p.from)) + 0.4;
      const zoomed = Math.max(...ZOOMS.map((zoom) => zoom.at + zoom.duration));
      assert.ok(last < GROWTH_CLOCK.rest && zoomed < GROWTH_CLOCK.rest && GROWTH_CLOCK.rest < GROWTH_CLOCK.end);
    });

    it('shows only the Month 6 chapter, and its counts match the people shown', () => {
      const chapters = places.filter((place) => classesOf(place.element).includes('chapter'));
      assert.deepEqual(chapters.filter(still).map((place) => textOf(place.element)), ['Month 6']);
      const line = places.find((place) => classesOf(place.element).includes('sub') && still(place));
      const teams = labels('lead').filter(still).length - 1;
      const members = labels('member').filter(still).length;
      assert.equal(line === undefined ? '' : textOf(line.element), `${teams} teams and ${members} members. You still talk to one lead.`);
      assert.deepEqual([teams, members], [8, 33]);
      assert.equal(labels('you').filter(still).length, 1);
    });

    it('shows no one who has moved on, and no dashed outline', () => {
      const leavers = new Set(PEOPLE.filter((p) => p.leaves !== undefined).map((p) => p.label));
      assert.deepEqual([...leavers].sort(), ['docs', 'invoices', 'perf', 'sync']);
      const shown = [...labels('member'), ...labels('gone')].filter(still).map((place) => textOf(place.element));
      assert.ok(shown.every((name) => !leavers.has(name)), shown.join(', '));
      assert.ok(places.filter((place) => classesOf(place.element).includes('tag')).every((place) => !still(place)));
    });

    it('holds the camera at its last zoom', () => {
      const camera = places.find((place) => place.element.name === 'g' && (rules.get(`.${animationOf(place.element)}`) ?? '').includes('transform-origin:0 0'));
      assert.equal(valueOf(rules.get(`.${animationOf(camera?.element)}`) ?? '', 'transform'), `translate(480px,258px) scale(${ZOOMS.at(-1)?.scale})`);
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

describe('layoutErrors', () => {
  it('finds nothing wrong with the story as drawn', () => {
    assert.deepEqual(layoutErrors(PEOPLE, ZOOMS), []);
  });

  it('finds a person off screen at the scale the camera has when the person joins', () => {
    const far = person('far', 700, 0, { from: 6 });
    assert.deepEqual(layoutErrors([far], []), ['far is off screen at scale 1: 1132,239,1229,277']);
    assert.deepEqual(layoutErrors([far], [{ at: 1, duration: 1, scale: 0.5 }]), []);
    assert.equal(layoutErrors([far], [{ at: 5.5, duration: 1, scale: 0.5 }]).length, 1, 'a zoom still under way does not count');
  });

  it('finds two people on screen together that overlap, but not people who take turns in one spot or never meet', () => {
    assert.deepEqual(layoutErrors([person('a', 0, 0), person('b', 40, 0)], []), ['a overlaps b']);
    assert.deepEqual(layoutErrors([person('a', 0, 0, { leaves: 2 }), person('b', 0, 0, { from: 5 })], []), []);
    assert.deepEqual(layoutErrors([person('a', 0, 0, { leaves: 2 }), person('b', 40, 0, { from: 5 })], []), []);
  });

  it('finds a line that runs through a person', () => {
    const parent = person('parent', -350, 0);
    const child = person('child', 350, 0, { parent });
    assert.deepEqual(layoutErrors([parent, child, person('middle', 0, 0)], []), ['the line parent -> child crosses middle']);
    assert.deepEqual(layoutErrors([parent, child, person('aside', 0, 80)], []), []);
  });
});
