import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER, CARD_LINE, CARDS, LEAD_MEETING_CLOCK, MEETING_VIEW_HEIGHT, MEETING_WINDOW_HEIGHT, OPTION_GAP, renderLeadMeeting, TABS, TALK, WEB_ANSWERED } from './lead-meeting.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { DIVIDER_X, MONO_SIZE, tabX, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT } from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderLeadMeeting();
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

/** Every text of the picture, where it starts or ends, and a generous guess at its width, with the gaps before its spans. */
const texts = places
  .filter((place) => place.element.name === 'text')
  .map(({ element }) => {
    const words = textOf(element);
    const x = number(element.attributes.get('x'));
    const gaps = element.children.reduce((sum, child) => sum + (typeof child === 'string' ? 0 : Number(child.attributes.get('dx') ?? 0)), 0);
    const width = words.length * 0.62 * MONO_SIZE + gaps;
    const left = element.attributes.get('text-anchor') === 'end' ? x - width : x;
    return { words, left, right: left + width, y: number(element.attributes.get('y')) };
  });

/** Each line of talk and each card as one block: where it starts and ends, and when it appears. */
const blocks = [
  ...TALK.map((line) => ({ top: line.y, bottom: line.y, from: line.from })),
  ...CARDS.map((card) => ({ top: card.y, bottom: card.y + 2 * CARD_LINE, from: card.from })),
].sort((a, b) => a.top - b.top);

const said = (words: string): number => TALK.find((line) => line.words.includes(words))?.from ?? Number.NaN;

describe('renderLeadMeeting', () => {
  it('draws the same bytes every time, as well-formed XML, the terminal view taller by its window', () => {
    assert.equal(renderLeadMeeting(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(MEETING_VIEW_HEIGHT));
    assert.equal(MEETING_VIEW_HEIGHT - MEETING_WINDOW_HEIGHT, VIEW_HEIGHT - WINDOW_HEIGHT, 'the key keeps its room under the window');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.startsWith("Your morning meeting in the lead's tab."), label);
    assert.ok(label.includes("the sessions hold the messages that aren't critical until it ends"), label);
    for (const [i, card] of CARDS.entries()) assert.ok(label.includes(`${i + 1}, ${card.task}: ${card.ask} ${card.options.join(' ')} ${card.rec}`), card.task);
    assert.ok(label.includes(`You answer all three in one line: ${ANSWER}.`), label);
    assert.ok(label.endsWith('and the meeting closes: the held messages go out.'), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('opens its stylesheet with the theme and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.equal(animated.size, TALK.length + CARDS.length + 2, 'a class per line and per card, two for web');
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

  describe('its still picture, which reduced motion shows: the whole meeting told', () => {
    it('rests after the last line is in and before the loop clears', () => {
      const last = Math.max(...blocks.map((block) => block.from), WEB_ANSWERED);
      assert.ok(last < LEAD_MEETING_CLOCK.rest && LEAD_MEETING_CLOCK.rest < LEAD_MEETING_CLOCK.end);
    });

    it('shows every line of the talk and of each card', () => {
      for (const line of TALK) assert.deepEqual(named(line.words).map(still), [true], line.words);
      for (const card of CARDS) {
        for (const words of [card.task, card.ask, card.options.join(''), card.rec]) assert.deepEqual(named(words).map(still), [true], words);
      }
    });

    it("shows every tab, the lead's name bold", () => {
      for (const tab of TABS) assert.deepEqual(named(tab.name).map(still), [true], tab.name);
      assert.deepEqual(classesOf(named('lead')[0]?.element), ['mono', 'strong']);
    });

    it('marks each tab and key entry as it stands at the still: web back at work', () => {
      // Tabs lead, api, web and data working; one mark each in the key.
      const expected: ReadonlyArray<[string, number]> = [['working', 5], ['needs', 1], ['open', 1], ['done', 1]];
      for (const [name, count] of expected) assert.equal(withClass(name).filter(still).length, count, name);
    });
  });

  it('keeps each text in its place: tabs in their tab, the talk inside the window, the key under it', () => {
    for (const found of texts) {
      if (found.y < 44) {
        const tab = Math.floor((found.left - tabX(0)) / (tabX(1) - tabX(0)));
        assert.ok(found.right <= tabX(tab) + 92, `tab text runs out of its tab: ${found.words}`);
      } else if (found.y < MEETING_WINDOW_HEIGHT) {
        assert.ok(found.right <= WIDTH - 16, `talk runs out of the window: ${found.words}`);
      } else {
        assert.ok(found.y < MEETING_VIEW_HEIGHT && found.right <= WIDTH, `key text leaves the picture: ${found.words}`);
      }
    }
  });

  it("sets each card's option B a gap after A, one the font cannot collapse as it does a run of spaces", () => {
    for (const card of CARDS) {
      const line = named(card.options.join(''))[0]?.element;
      const [a, span] = line?.children ?? [];
      assert.equal(a, card.options[0], card.task);
      assert.ok(typeof span !== 'string' && span?.name === 'tspan', card.task);
      assert.equal(textOf(span), card.options[1], card.task);
      assert.equal(span.attributes.get('dx'), String(OPTION_GAP), card.task);
      assert.ok(OPTION_GAP >= MONO_SIZE, 'wider than a character');
    }
  });

  it('keeps the talk and the cards in time order, a line apart, and above the window bottom', () => {
    assert.ok(blocks.every((block, i) => i === 0 || (block.top >= (blocks[i - 1]?.bottom ?? 0) + 20 && block.from > (blocks[i - 1]?.from ?? 0))));
    assert.ok((blocks.at(-1)?.bottom ?? Number.POSITIVE_INFINITY) < MEETING_WINDOW_HEIGHT - 16);
  });

  it('folds its tool run into one line, as Claude Code shows it', () => {
    const runs = TALK.filter((line) => /^(Read|Ran) /.test(line.words));
    assert.deepEqual(runs.map((run) => [run.words, run.look]), [['Read 1 file, ran 4 shell commands', 'output']]);
  });

  describe('tells one story', () => {
    it('holds the messages that are not critical from the meeting opening, and sends them once it closes', () => {
      assert.ok(TALK.find((line) => line.look === 'said')?.words.includes("Sessions hold the messages that aren't critical until it ends."));
      assert.ok(TALK.at(-1)?.words.endsWith('Meeting closed: the held messages go out now.'));
    });

    it('says what got done, what is late and what your earlier OK started, before the cards', () => {
      const first = Math.min(...CARDS.map((card) => card.from));
      assert.ok(said('tasks are done and 1 is late') < first);
      assert.ok(said('Your OK last night already started') < first);
    });

    it('builds each card the same way: task, facts in numbers, options with their cost, a pick with its reason and the no-answer default', () => {
      for (const card of CARDS) {
        assert.match(card.task, /^T\d+$/);
        assert.match(card.ask, /\d/, card.task);
        assert.match(card.options[0], /^A: .+.$/, card.task);
        assert.match(card.options[1], /^B: .+.$/, card.task);
        assert.match(card.rec, /^Rec: [AB], .+\. With no answer: [AB][.,]/, card.task);
      }
    });

    it('takes your answer to every card in one line, after the last card, and records each on its task', () => {
      const numbers = [...ANSWER.matchAll(/(\d+) /g)].map((found) => Number(found[1]));
      assert.deepEqual(numbers, CARDS.map((_, i) => i + 1));
      assert.equal(TALK.find((line) => line.words === ANSWER)?.look, 'ask');
      assert.ok(Math.max(...CARDS.map((card) => card.from)) < said(ANSWER));
      for (const card of CARDS) assert.ok(TALK.at(-1)?.words.includes(card.task), card.task);
    });

    it('sends web back to work, the one tab that needed you, once the lead records your answer', () => {
      const track = TABS.find((story) => story.name === 'web')?.track;
      assert.ok(typeof track !== 'string' && track !== undefined);
      assert.deepEqual(track.map((change) => change.status), ['needs-you', 'working']);
      assert.equal(track[1]?.at, WEB_ANSWERED);
      assert.ok(said('web starts guest checkout') < WEB_ANSWERED);
      assert.deepEqual(TABS.filter((story) => story.track !== 'working').map((story) => story.name), ['web']);
    });
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
