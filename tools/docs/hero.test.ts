import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHAR_WIDTH, HERO_CLOCK, HERO_SCROLL, HERO_TYPING, renderHero } from './hero.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderHero();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

const named = (words: string): XmlPlace[] => places.filter((place) => place.element.name === 'text' && textOf(place.element) === words);
const filled = (shape: string, fill: string): XmlPlace[] => places.filter((place) => place.element.name === shape && place.element.attributes.get('fill') === fill && classesOf(place.element).length > 0);

describe('renderHero', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderHero(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /the user types: Build a signup flow: an API, a web form and tests\./);
    assert.match(label, /All 3 tasks done\. Ready for your review\.$/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > 40, `only ${animated.size} animated classes`);
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

  describe('its still picture, which reduced motion shows: the finished work', () => {
    it('rests after the last task is done (web, at 15.0 s) and the talk has scrolled, and before the loop clears', () => {
      assert.ok(15.0 < HERO_CLOCK.rest && HERO_SCROLL.at + HERO_SCROLL.duration < HERO_CLOCK.rest && HERO_CLOCK.rest < HERO_CLOCK.end);
    });

    it('holds the talk scrolled up, as a terminal does', () => {
      const chat = places.find((place) => place.element.attributes.get('clip-path') === 'url(#chat)')?.element;
      const scroll = (chat?.children ?? []).find((node): node is XmlElement => typeof node !== 'string');
      assert.equal(valueOf(rules.get(`.${classesOf(scroll)[0] ?? ''}`) ?? '', 'transform'), `translateY(-${HERO_SCROLL.distance}px)`);
    });

    it("shows the end of the talk inside the window, from the hire question to the lead's final report", () => {
      const inside = (place: XmlPlace): boolean => {
        const y = Number(place.element.attributes.get('y')) - HERO_SCROLL.distance;
        return y > 50 + 15 && y < 372;
      };
      const shown = [
        'Shall I hire them?',
        '> yes',
        'Hired. 3 members, 3 tasks, all at work.',
        'web needs your decision:',
        'Should the form also offer Google sign-in?',
        '> Email only for now.',
        'Got it. web is back at work.',
        'All 3 tasks done. Ready for your review.',
      ];
      for (const words of shown) {
        const found = named(words);
        assert.equal(found.length, 1, words);
        assert.ok(found.every((place) => still(place) && inside(place)), words);
      }
      for (const words of ['> Build a signup flow: an API, a web form and tests.', "I'll hire a team of three:"]) {
        const found = named(words);
        assert.equal(found.length, 1, words);
        assert.ok(found.every((place) => !inside(place)), `${words} is scrolled out`);
      }
    });

    it('shows three of three done, every task done and every tab green, and no one waiting on you', () => {
      assert.ok(named('3 of 3 done').every(still));
      for (const label of ['no tasks yet', '0 of 3 done', '1 of 3 done', '2 of 3 done']) assert.ok(!named(label).some(still), label);
      const pills = (label: string): XmlPlace[] => named(label).filter((place) => classesOf(place.element).includes('small'));
      assert.deepEqual([pills('done').length, pills('done').filter(still).length], [3, 3]);
      for (const [label, count] of [['open', 3], ['in progress', 4], ['needs you', 1]] as const) {
        assert.deepEqual([pills(label).length, pills(label).filter(still).length], [count, 0], label);
      }
      assert.deepEqual([filled('circle', '#3fb950').length, filled('circle', '#3fb950').filter(still).length], [3, 3]);
      for (const color of ['#d29922', '#a371f7', '#6e7681']) assert.equal(filled('circle', color).filter(still).length, 0, color);
      assert.deepEqual([filled('rect', '#3fb950').length, filled('rect', '#3fb950').filter(still).length], [3, 3]);
    });

    it('leaves the input box empty', () => {
      const box = places.find((place) => place.element.attributes.get('clip-path') === 'url(#box)');
      assert.ok(box !== undefined);
      const typed = places.filter((place) => place.path.includes(box.element) && place.element.name === 'text');
      assert.equal(typed.length, HERO_TYPING.length);
      assert.ok(!typed.some(still));
    });
  });

  it('types each text one step per character, with its cover and the caret on the same steps', () => {
    const box = places.find((place) => place.element.attributes.get('clip-path') === 'url(#box)')?.element;
    const groups = (box?.children ?? []).filter((node): node is XmlElement => typeof node !== 'string');
    const stepsOf = (element: XmlElement | undefined): number[] => {
      return [...(frames.get(classesOf(element)[0] ?? '')?.body.matchAll(/steps\((\d+),end\)/g) ?? [])].map((found) => Number(found[1]));
    };
    HERO_TYPING.forEach((typing, i) => {
      const chars = typing.text.length;
      const [text, cover] = (groups[i]?.children ?? []).filter((node): node is XmlElement => typeof node !== 'string');
      assert.equal(text === undefined ? '' : textOf(text), typing.text);
      assert.equal(text?.attributes.get('textLength'), String(chars * CHAR_WIDTH));
      assert.deepEqual(stepsOf(cover), [chars]);
      assert.ok(frames.get(classesOf(cover)[0] ?? '')?.body.includes(`translateX(${(chars * CHAR_WIDTH).toFixed(1)}px)`), typing.text);
      assert.ok(typing.from + chars * typing.perChar < typing.sent, `"${typing.text}" is sent before it is typed`);
    });
    assert.deepEqual(stepsOf(groups.at(-1)), HERO_TYPING.map((typing) => typing.text.length));
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
