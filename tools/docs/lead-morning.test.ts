import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_ANSWERED, FREE, LEAD_MORNING_CLOCK, PLAN, renderLeadMorning, TABS, TALK } from './lead-morning.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { DIVIDER_X, MONO_SIZE, tabX, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT } from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderLeadMorning();
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

describe('renderLeadMorning', () => {
  it('draws the same bytes every time, as well-formed XML the height of the terminal view', () => {
    assert.equal(renderLeadMorning(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(VIEW_HEIGHT));
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.startsWith("A lead's morning in its own tab, one plain sentence a step"), label);
    assert.ok(label.includes(`the lead fills it to ${PLAN.after}, fitted to the week's tokens`), label);
    assert.ok(label.includes('so it closes docs and tests, idle with nothing to start'), label);
    assert.ok(label.endsWith('so it waits for your morning meeting.'), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('opens its stylesheet with the theme and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.equal(animated.size, TALK.length + 4, 'a class per line, two for data, one per closed tab');
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

  it('spans the conversation across the window: no pane, no line between', () => {
    assert.ok(!named('teamrig-pane').length, 'no pane heading');
    const rule = places.find((place) => classesOf(place.element).includes('rule'))?.element.attributes.get('d') ?? '';
    assert.ok(!rule.includes(`M${DIVIDER_X + 0.5} `), rule);
  });

  describe('its still picture, which reduced motion shows: the whole morning told', () => {
    it('rests after the last line is in and before the loop clears', () => {
      const last = TALK.at(-1)?.from ?? Number.POSITIVE_INFINITY;
      assert.ok(last < LEAD_MORNING_CLOCK.rest && LEAD_MORNING_CLOCK.rest < LEAD_MORNING_CLOCK.end);
    });

    it("shows every line of the lead's talk", () => {
      for (const line of TALK) assert.deepEqual(named(line.words).map(still), [true], line.words);
    });

    it("shows the tabs still open and none of the closed ones, the lead's name bold", () => {
      for (const tab of TABS) assert.deepEqual(named(tab.name).map(still), [tab.closed === undefined], tab.name);
      assert.deepEqual(classesOf(named('lead')[0]?.element), ['mono', 'strong']);
    });

    it('marks each open tab and key entry as it stands at the still', () => {
      // Tabs lead, api, data working, web needing you; one mark each in the key.
      const expected: ReadonlyArray<[string, number]> = [['working', 4], ['needs', 2], ['open', 1], ['done', 1]];
      for (const [name, count] of expected) assert.equal(withClass(name).filter(still).length, count, name);
    });
  });

  it('keeps each text in its place: tabs in their tab, the talk inside the window, the key under it', () => {
    for (const found of texts) {
      if (found.y < 44) {
        const tab = Math.floor((found.left - tabX(0)) / (tabX(1) - tabX(0)));
        assert.ok(found.right <= tabX(tab) + 92, `tab text runs out of its tab: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT) {
        assert.ok(found.right <= WIDTH - 16, `talk runs out of the window: ${found.words}`);
      } else {
        assert.ok(found.y < VIEW_HEIGHT && found.right <= WIDTH, `key text leaves the picture: ${found.words}`);
      }
    }
  });

  it('keeps the talk in time order, a line apart, and above the window bottom', () => {
    assert.ok(TALK.every((line, i) => i === 0 || (line.y >= (TALK[i - 1]?.y ?? 0) + 20 && line.from > (TALK[i - 1]?.from ?? 0))));
    assert.ok((TALK.at(-1)?.y ?? Number.POSITIVE_INFINITY) < WINDOW_HEIGHT - 16);
  });

  it('folds every tool run into one line, as Claude Code shows it', () => {
    const runs = TALK.filter((line) => line.words.startsWith('Ran '));
    assert.equal(runs.length, 3);
    for (const run of runs) assert.match(run.words, /^Ran \d+ shell commands$/);
    assert.ok(runs.every((run) => run.look === 'output'));
  });

  describe('tells one story', () => {
    const tab = (name: string): (typeof TABS)[number] | undefined => TABS.find((story) => story.name === name);
    const said = (words: string): number => TALK.find((line) => line.words.includes(words))?.from ?? Number.NaN;

    it('data goes back to work once the lead has sent it the answer', () => {
      const track = tab('data')?.track;
      assert.ok(typeof track !== 'string' && track !== undefined);
      assert.deepEqual(track.map((change) => change.status), ['needs-you', 'working']);
      assert.equal(track[1]?.at, DATA_ANSWERED);
      assert.ok(said('sent to data') < DATA_ANSWERED);
    });

    it('fills the plan with the tasks due outside it', () => {
      assert.equal(PLAN.after, PLAN.before + PLAN.missing);
      assert.ok(PLAN.flagsAfter < PLAN.flagsBefore);
      assert.ok(Number.parseFloat(FREE.after) > Number.parseFloat(FREE.before));
    });

    it('closes only idle sessions, the ones it names, after it says so and while their tool run is out', () => {
      const closed = TABS.filter((story) => story.closed !== undefined);
      assert.deepEqual(closed.map((story) => story.name), ['docs', 'tests']);
      for (const story of closed) {
        assert.equal(story.track, 'done', story.name);
        assert.ok(said(`${story.name}`) < (story.closed ?? 0), story.name);
        assert.ok(said('Ran 2 shell commands') < (story.closed ?? 0) && (story.closed ?? 0) < said(FREE.after), story.name);
      }
    });

    it("leaves web's question, the one tab still needing you, for your meeting", () => {
      assert.equal(tab('web')?.track, 'needs-you');
      assert.ok(TALK.at(-1)?.words.includes("web's question is a product call"));
    });
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
