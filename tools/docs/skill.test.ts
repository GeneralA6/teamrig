import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_DONE, API_TALK, COLUMNS_SHOWN, LEAD_TALK, renderSkill, ROWS, SCORECARD, SKILL, SKILL_CLOCK, SKIPPED, SWITCH, TABS } from './skill.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { DIVIDER_X, MONO_SIZE, tabX, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT } from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderSkill();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const rules = rulesIn(css);
const frames = keyframesIn(css);
const number = (value: string | undefined): number => Number(value ?? Number.NaN);
const label = root.attributes.get('aria-label') ?? '';

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

/** The commands doc, which its own specs hold to the CLI. */
const COMMANDS_DOC = readFileSync(new URL('../../docs/commands.md', import.meta.url), 'utf8');

const inOrder = (lines: ReadonlyArray<{ readonly y: number; readonly from: number }>): boolean =>
  lines.every((line, i) => i === 0 || (line.y >= (lines[i - 1]?.y ?? 0) + 20 && line.from > (lines[i - 1]?.from ?? 0)));

const cellsOf = (line: string | undefined): string[] =>
  (line ?? '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '');

const fromOf = (words: string): number => [...API_TALK, ...LEAD_TALK].find((line) => line.words.startsWith(words))?.from ?? Number.NaN;

describe('renderSkill', () => {
  it('draws the same bytes every time, as well-formed XML the height of the terminal view', () => {
    assert.equal(renderSkill(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(VIEW_HEIGHT));
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.startsWith('A procedure becomes a skill.'), label);
    assert.ok(label.includes(`a skill, ${SKILL}, in the same turn`), label);
    assert.ok(label.endsWith('so the lead asks web why.'), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('opens its stylesheet with the theme and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > API_TALK.length + LEAD_TALK.length, `${animated.size} animated classes`);
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

  it('spans the output across the window: no pane, no line between', () => {
    assert.ok(!named('teamrig-pane').length, 'no pane heading');
    const rule = places.find((place) => classesOf(place.element).includes('rule'))?.element.attributes.get('d') ?? '';
    assert.ok(!rule.includes(`M${DIVIDER_X + 0.5} `), rule);
  });

  describe('its still picture, which reduced motion shows: the lead reading the scorecard', () => {
    it("rests after the lead's last line and before the parts hide", () => {
      assert.ok((LEAD_TALK.at(-1)?.from ?? Number.POSITIVE_INFINITY) < SKILL_CLOCK.rest && SKILL_CLOCK.rest < SKILL_CLOCK.end);
    });

    it("shows every line of the lead's talk and none of api's", () => {
      for (const line of LEAD_TALK) assert.deepEqual(named(line.words).map(still), [true], line.words);
      for (const line of API_TALK) assert.deepEqual(named(line.words).map(still), [false], line.words);
    });

    it("shows the lead's tab in view, its name bold and api's no longer", () => {
      assert.deepEqual(named('lead').map(still), [false, true]);
      assert.deepEqual(classesOf(named('lead')[1]?.element), ['mono', 'strong']);
      assert.deepEqual(named('api').map(still), [false, true]);
      assert.deepEqual(classesOf(named('api')[1]?.element), ['mono', 'muted']);
      for (const name of ['web', 'data']) assert.deepEqual(named(name).map(still), [true], name);
    });

    it('marks each tab and key entry as it stands at the still', () => {
      // lead and web working, api and data done; one mark each in the key.
      const expected: ReadonlyArray<[string, number]> = [['working', 3], ['done', 3], ['needs', 1], ['open', 1]];
      for (const [name, count] of expected) assert.equal(withClass(name).filter(still).length, count, name);
    });
  });

  it('keeps each text in its place: tabs in their tab, the output inside the window, the key under it', () => {
    for (const found of texts) {
      if (found.y < 44) {
        const tab = Math.floor((found.left - tabX(0)) / (tabX(1) - tabX(0)));
        assert.ok(found.right <= tabX(tab) + 92, `tab text runs out of its tab: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT) {
        assert.ok(found.right <= WIDTH - 16, `output runs out of the window: ${found.words}`);
      } else {
        assert.ok(found.y < VIEW_HEIGHT && found.right <= WIDTH, `key text leaves the picture: ${found.words}`);
      }
    }
  });

  it("keeps api's talk and the lead's in time order, a line apart, and above the window bottom", () => {
    for (const lines of [API_TALK, LEAD_TALK]) {
      assert.ok(inOrder(lines));
      assert.ok((lines.at(-1)?.y ?? Number.POSITIVE_INFINITY) < WINDOW_HEIGHT - 16);
    }
  });

  describe('tells one story', () => {
    it("has api write the skill, then marks api's task done, then brings the lead's tab into view", () => {
      const api = TABS.find((tab) => tab.name === 'api')?.track;
      assert.deepEqual(typeof api === 'string' ? [] : api?.map((change) => change.status), ['working', 'done']);
      assert.ok(fromOf(`Wrote 21 lines to ~/.claude/skills/${SKILL}/SKILL.md`) < API_DONE && API_DONE < SWITCH);
      assert.ok((API_TALK.at(-1)?.from ?? Number.POSITIVE_INFINITY) < SWITCH);
      assert.ok(SWITCH < (LEAD_TALK[0]?.from ?? 0));
    });

    it("names the skill on the task's record", () => {
      assert.ok(API_TALK.at(-1)?.words.includes(`names the skill it left: ${SKILL}.`));
    });

    it('runs a real command a week on: teamrig skills scorecard', () => {
      assert.deepEqual(
        LEAD_TALK.filter((line) => line.look === 'command').map((line) => line.words),
        ['teamrig skills scorecard'],
      );
      assert.ok(COMMANDS_DOC.includes('skills scorecard'));
    });

    it("prints the scorecard's heading, then its table cut to the first columns", () => {
      assert.ok(SCORECARD[0]?.startsWith('Skills scorecard '), SCORECARD[0]);
      assert.deepEqual(cellsOf(SCORECARD[1]), ['skill', 'loads', 'missed', 'calls/run', 'base calls/run', 'err/run', 'base err/run']);
      assert.deepEqual(cellsOf(SCORECARD[2]), Array.from({ length: COLUMNS_SHOWN }, () => '---'));
      assert.deepEqual(
        SCORECARD.slice(3).map((line) => cellsOf(line).slice(0, 3)),
        ROWS.map((row) => [row.skill, String(row.loads), String(row.missed)]),
      );
      for (const line of SCORECARD) assert.equal(named(line).length, 1, line);
    });

    it("has the lead read the scorecard's own numbers", () => {
      const [deploy, skipped] = ROWS;
      const pays = LEAD_TALK.find((line) => line.words.startsWith(`${SKILL} pays its way`))?.words ?? '';
      assert.ok(pays.includes(`${deploy?.loads} runs at ${deploy?.callsPerRun?.toFixed(1)} calls each`), pays);
      assert.ok(pays.includes(`against ${deploy?.baseCallsPerRun?.toFixed(1)} by hand`), pays);
      const never = LEAD_TALK.find((line) => line.words.startsWith(SKIPPED))?.words ?? '';
      assert.equal(skipped?.loads, 0);
      assert.ok(never.includes(`by hand ${skipped?.missed} times`), never);
    });
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
