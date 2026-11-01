import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESTORE_TAB_TITLE } from '../../src/cli/commands/restore.ts';
import { COUNTDOWN_SECONDS } from '../../src/restore/run.ts';
import {
  CONTINUE_NOTE,
  COUNTDOWN,
  LEAD_IN_VIEW,
  modeWords,
  PRINTED,
  PROMPT_FROM,
  PROMPT_SHOWN,
  REBOOT_CLOCK,
  renderReboot,
  RESTORE_CLOSED,
  SESSIONS,
  TALK,
} from './reboot.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn, valueOf } from './stylesheet.ts';
import { DIVIDER_X, MONO_SIZE, tabX, VIEW_HEIGHT, WIDTH, WINDOW_HEIGHT } from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf, type XmlElement, type XmlPlace } from './xml.ts';

const svg = renderReboot();
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

/** The restore's source with its `'…' + '…'` string pieces joined, so a sentence split across lines reads whole. */
const RUN_SOURCE = readFileSync(new URL('../../src/restore/run.ts', import.meta.url), 'utf8').replace(/'\s*\+\s*'/g, '');

const inOrder = (lines: ReadonlyArray<{ readonly y: number; readonly from: number }>): boolean =>
  lines.every((line, i) => i === 0 || (line.y >= (lines[i - 1]?.y ?? 0) + 20 && line.from > (lines[i - 1]?.from ?? 0)));

describe('renderReboot', () => {
  it('draws the same bytes every time, as well-formed XML the height of the terminal view', () => {
    assert.equal(renderReboot(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(VIEW_HEIGHT));
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.startsWith(`After a reboot, a tab named ${RESTORE_TAB_TITLE} opens at logon`), label);
    assert.ok(label.includes(`lists the ${SESSIONS.length} Claude Code sessions the shutdown killed`), label);
    assert.ok(label.endsWith('nothing was lost.'), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('opens its stylesheet with the theme and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('runs every animated class on keyframes that exist and ascend from 0% to 100%', () => {
    const animated = animationsIn(css);
    assert.ok(animated.size > PRINTED.length, `${animated.size} animated classes`);
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

  describe("its still picture, which reduced motion shows: the restore's whole list, every session back", () => {
    it('rests after the last session opens and before the restore tab closes', () => {
      const last = PRINTED.at(-1)?.from ?? Number.POSITIVE_INFINITY;
      assert.ok(last < REBOOT_CLOCK.rest && REBOOT_CLOCK.rest < RESTORE_CLOSED && RESTORE_CLOSED < REBOOT_CLOCK.end);
    });

    it('shows every line the restore printed', () => {
      for (const line of PRINTED) assert.deepEqual(named(line.words).map(still), [true], line.words);
    });

    it("shows none of the lead's prompt or talk", () => {
      for (const words of [...PROMPT_SHOWN, ...TALK.map((line) => line.words)]) assert.deepEqual(named(words).map(still), [false], words);
    });

    it("shows the restore's tab and a tab for each session, the lead's name not yet bold", () => {
      assert.deepEqual(named('restore').map(still), [true]);
      for (const session of SESSIONS) {
        const expected = session.name === 'lead' ? [true, false] : [true];
        assert.deepEqual(named(session.name).map(still), expected, session.name);
      }
      assert.deepEqual(classesOf(named('lead')[1]?.element), ['mono', 'strong']);
    });

    it('marks each tab and key entry as it stands at the still', () => {
      // lead, api and data working, web done with nothing to do; one mark each in the key.
      const expected: ReadonlyArray<[string, number]> = [['working', 4], ['needs', 1], ['open', 1], ['done', 2]];
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

  it("keeps the restore's lines and the lead's talk in time order, a line apart, and above the window bottom", () => {
    assert.ok(inOrder(PRINTED));
    assert.ok(inOrder(TALK));
    for (const lines of [PRINTED, TALK]) assert.ok((lines.at(-1)?.y ?? Number.POSITIVE_INFINITY) < WINDOW_HEIGHT - 16);
  });

  describe('tells one story', () => {
    const opened = PRINTED.filter((line) => line.words.startsWith('Opened '));

    it('lists each session with why it was killed, how it comes back and its folder, then opens it the same way', () => {
      assert.deepEqual(
        opened.map((line) => line.words),
        SESSIONS.map((session) => `Opened ${session.label} (${modeWords(session)})`),
      );
      for (const session of SESSIONS) {
        assert.ok(named(`${session.label} [${session.reason}; ${modeWords(session)}] ${session.folder}`).length === 1, session.label);
      }
    });

    it('puts back to work the sessions marked continue, and reopens the idle one with nothing to do', () => {
      for (const session of SESSIONS) assert.equal(session.status, session.mode === 'continue' ? 'working' : 'done', session.name);
      assert.deepEqual(
        SESSIONS.filter((session) => session.mode === 'idle').map((session) => session.name),
        ['web'],
      );
    });

    it('counts down before it opens the first, then closes its tab once the last is open', () => {
      const countdown = PRINTED.find((line) => line.words === COUNTDOWN);
      assert.ok(COUNTDOWN.startsWith(`Starting in ${COUNTDOWN_SECONDS}s`), COUNTDOWN);
      assert.ok((countdown?.from ?? Number.POSITIVE_INFINITY) < (opened[0]?.from ?? 0));
      assert.ok((opened.at(-1)?.from ?? Number.POSITIVE_INFINITY) + 0.6 < RESTORE_CLOSED);
    });

    it("shows the lead's tab once the restore's has closed, prompted with how every other session came back", () => {
      assert.ok(RESTORE_CLOSED < LEAD_IN_VIEW && LEAD_IN_VIEW < PROMPT_FROM && PROMPT_FROM < (TALK[0]?.from ?? 0));
      for (const session of SESSIONS.filter((one) => one.name !== 'lead')) {
        const how = session.mode === 'continue' ? `${session.label} continue (${session.why})` : `${session.label} idle`;
        assert.ok(PROMPT_SHOWN[1].includes(how), how);
      }
    });

    it('has the lead say how each session came back before it carries on', () => {
      const back = TALK.find((line) => line.words.startsWith('Back after the restart'))?.words ?? '';
      for (const session of SESSIONS.filter((one) => one.name !== 'lead')) assert.ok(back.includes(session.name), session.name);
    });
  });

  describe("prints what `teamrig restore run` prints (src/restore/run.ts)", () => {
    it('its header, each listed session and each opened tab', () => {
      assert.ok(RUN_SOURCE.includes('deps.print(`Claude Code sessions the last shutdown interrupted (${items.length}):`)'));
      assert.ok(RUN_SOURCE.includes('[${item.reason}; ${modeWords(item)}]   ${item.entry.projectDir}`'));
      assert.ok(RUN_SOURCE.includes('deps.print(`Opened ${item.label} (${modeWords(item)})`)'));
      assert.equal(PRINTED[0]?.words, `Claude Code sessions the last shutdown interrupted (${SESSIONS.length}):`);
    });

    it('its note under the list, word for word', () => {
      assert.ok(RUN_SOURCE.includes(`'${CONTINUE_NOTE.join(' ')}'`));
    });

    it('its words for how a session comes back', () => {
      assert.ok(RUN_SOURCE.includes("return item.mode === 'continue' ? `continue: ${item.why}` : 'idle';"));
    });
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
