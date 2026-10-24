import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import {
  API_TALK,
  ASK,
  ASK_TYPING,
  CHAR_WIDTH,
  LEAD_TALK,
  NEW_ROW,
  renderTaskFlow,
  ROWS_ABOVE,
  ROWS_BELOW,
  TABS,
  TASK_FLOW_CLOCK,
} from './task-flow.ts';
import type { Change, Line, Track } from './story.ts';
import { DIVIDER_X, MONO_SIZE, PANE_LEFT, PANE_RIGHT, ROW_STEP, ROW_TOP, tabX, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT } from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderTaskFlow();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);
const number = (value: string | undefined): number => Number(value ?? Number.NaN);

const classesOf = (element: XmlElement | undefined): string[] => (element?.attributes.get('class') ?? '').split(/\s+/).filter((name) => name !== '');

/** Seen in the still picture (motion off): every class on the element or above it that sets an opacity sets 1. */
const still = (place: XmlPlace): boolean =>
  place.path.every((element) => classesOf(element).every((name) => (valueOf(rules.get(`.${name}`) ?? '', 'opacity') ?? '1') === '1'));

/** The still transform of the nearest element around a place that a class moves. */
const stillTransform = (place: XmlPlace | undefined): string | undefined =>
  (place?.path ?? [])
    .flatMap((element) => classesOf(element))
    .map((name) => valueOf(rules.get(`.${name}`) ?? '', 'transform'))
    .findLast((value) => value !== undefined);

const named = (words: string): XmlPlace[] => places.filter((place) => place.element.name === 'text' && textOf(place.element) === words);
const withClass = (name: string): XmlPlace[] => places.filter((place) => classesOf(place.element).includes(name));

/** Every text of the picture, where it starts or ends, and a generous guess at its width. */
const texts = places
  .filter((place) => place.element.name === 'text')
  .map(({ element }) => {
    const words = textOf(element);
    const x = number(element.attributes.get('x'));
    const width = words.length * 0.62 * MONO_SIZE;
    const left = element.attributes.get('text-anchor') === 'end' ? x - width : x;
    return { words, left, right: left + width, y: number(element.attributes.get('y')) };
  });

/** A track's changes from its first `status` on; none for a held status or one it never takes. */
const changesFrom = (track: Track, status: Change['status']): Change[] => {
  if (typeof track === 'string') return [];
  const at = track.findIndex((change) => change.status === status);
  return at === -1 ? [] : track.slice(at);
};
const doneAt = (track: Track): number | undefined => changesFrom(track, 'done')[0]?.at;

describe('renderTaskFlow', () => {
  it('draws the same bytes every time, as well-formed XML the height of the terminal view', () => {
    assert.equal(renderTaskFlow(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(VIEW_HEIGHT));
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.includes("In the lead's tab you type: Users need a password reset."), label);
    assert.ok(label.includes('lands it with teamrig integrate: it waits in line while web holds the lock'), label);
    assert.ok(label.endsWith("web's task and then T17 turn done in the pane."), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('opens its stylesheet with the theme and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('runs every animated class, the caret blink too, on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > 30, `only ${animated.size} animated classes`);
    assert.equal(animated.get('.blink'), 'blink');
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

  describe("its still picture, which reduced motion shows: api's tab with T17 done", () => {
    it('rests after T17 is done and before the loop clears', () => {
      const done = doneAt(NEW_ROW.track);
      assert.ok(done !== undefined && done < TASK_FLOW_CLOCK.rest && TASK_FLOW_CLOCK.rest < TASK_FLOW_CLOCK.end);
    });

    it("holds the outline on api's tab, its name bold and the lead's not", () => {
      const outline = places.find((place) => place.element.name === 'path' && classesOf(place.element).includes('tab'));
      assert.equal(stillTransform(outline), `translateX(${tabX(1) - tabX(0)}px)`);
      const strong = (name: string): XmlPlace[] => named(name).filter((place) => classesOf(place.element).includes('strong'));
      assert.deepEqual(strong('api').map(still), [true]);
      assert.deepEqual(strong('lead').map(still), [false]);
    });

    it("shows all of api's talk and none of the lead's", () => {
      const shown = (line: Line): boolean[] => named(line.words).map(still);
      for (const line of API_TALK) assert.deepEqual(shown(line), [true], line.words);
      for (const line of LEAD_TALK.filter((line) => line.look !== 'ask')) assert.deepEqual(shown(line), [false], line.words);
      assert.ok(!named(ASK).some(still), 'the ask is gone');
    });

    it("shows web's task and T17 done, muted, with the rows below T17 moved down for it", () => {
      for (const owner of ['web', 'api']) {
        assert.deepEqual(named(`${owner} · p1 · done`).map(still), [true], owner);
        assert.deepEqual(named(`${owner} · p1 · due today`).map(still), [false], owner);
      }
      for (const title of ['Signup form', NEW_ROW.title]) {
        assert.deepEqual(named(title).filter(still).map((place) => classesOf(place.element)), [['mono', 'muted']], title);
      }
      for (const entry of ROWS_BELOW) assert.equal(stillTransform(named(entry.id)[0]), `translateY(${ROW_STEP}px)`, entry.id);
    });

    it('marks each tab, row and key entry as it stands at the still', () => {
      // Tabs lead, api, web, tests, docs; rows T12, T17, T16, T15, T11; one mark each in the key.
      const expected: ReadonlyArray<[string, number]> = [['working', 4], ['done', 6], ['open', 3], ['needs', 1]];
      for (const [name, count] of expected) assert.equal(withClass(name).filter(still).length, count, name);
    });

    it('leaves the input box empty', () => {
      const typed = places.filter((place) => place.element.attributes.has('textLength'));
      assert.equal(typed.length, 1);
      assert.ok(!typed.some(still));
    });
  });

  it('types the ask one step per character, with its cover and the caret on the same steps, before it is sent', () => {
    const chars = ASK_TYPING.text.length;
    const typed = places.find((place) => place.element.attributes.has('textLength'))?.element;
    assert.equal(typed === undefined ? '' : textOf(typed), ASK);
    assert.equal(typed?.attributes.get('textLength'), (chars * CHAR_WIDTH).toFixed(1));
    const cover = classesOf(withClass('cover')[0]?.element).find((name) => /^a\d+$/.test(name)) ?? '';
    const caret = withClass('caret')[0]?.path.flatMap((element) => classesOf(element)).find((name) => /^a\d+$/.test(name));
    assert.equal(caret, cover);
    const body = frames.get(cover)?.body ?? '';
    assert.ok(body.includes(`steps(${chars},end)`), body);
    assert.ok(body.includes(`translateX(${(chars * CHAR_WIDTH).toFixed(1)}px)`), body);
    assert.ok(ASK_TYPING.from + chars * ASK_TYPING.perChar < ASK_TYPING.sent, 'the ask is sent before it is typed');
  });

  it('keeps each text in its place: tabs in their tab, the talk left of the pane, the rows inside it', () => {
    for (const found of texts) {
      if (found.y < 44) {
        const tab = Math.floor((found.left - tabX(0)) / (tabX(1) - tabX(0)));
        assert.ok(found.right <= tabX(tab) + 92, `tab text runs out of its tab: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT && found.left < DIVIDER_X) {
        assert.ok(found.right <= DIVIDER_X - 8, `talk runs into the pane: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT) {
        assert.ok(found.left >= PANE_LEFT && found.right <= PANE_RIGHT, `pane text leaves the pane: ${found.words}`);
      } else {
        assert.ok(found.y < VIEW_HEIGHT && found.right <= WIDTH, `key text leaves the picture: ${found.words}`);
      }
    }
  });

  it('keeps the talk above the input box, a line apart, and the moved rows inside the window', () => {
    for (const talk of [LEAD_TALK, API_TALK]) {
      assert.ok(talk.every((line, i) => i === 0 || (line.y >= (talk[i - 1]?.y ?? 0) + 20 && line.from > (talk[i - 1]?.from ?? 0))));
      assert.ok((talk.at(-1)?.y ?? Number.POSITIVE_INFINITY) < WINDOW_HEIGHT - 70.5 - 8);
    }
    const lastRowY = ROW_TOP + (ROWS_ABOVE.length + ROWS_BELOW.length) * ROW_STEP;
    assert.ok(lastRowY + 19 < WINDOW_HEIGHT - 8, `the last row's owner line at ${lastRowY + 19}`);
  });

  it("tells one story: api's tab follows T17, web's tab follows its task, and every row's owner has a tab", () => {
    const tab = (name: string): Track => TABS.find((story) => story.name === name)?.track ?? 'not-started';
    assert.deepEqual(changesFrom(tab('api'), 'working'), changesFrom(NEW_ROW.track, 'working'));
    const webTask = ROWS_ABOVE.find((entry) => entry.owner === 'web');
    assert.ok(webTask !== undefined && doneAt(tab('web')) !== undefined);
    assert.equal(doneAt(tab('web')), doneAt(webTask.track));
    for (const entry of [...ROWS_ABOVE, NEW_ROW, ...ROWS_BELOW]) assert.ok(TABS.some((story) => story.name === entry.owner), entry.owner);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
