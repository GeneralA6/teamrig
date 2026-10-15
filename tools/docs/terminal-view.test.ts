import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { animationsIn } from './stylesheet.ts';
import {
  ANSWER,
  ASK,
  CLOSING,
  DECISIONS,
  DIVIDER_X,
  KEY,
  KEY_ORDER,
  MONO_SIZE,
  OPENING,
  PANE_LEFT,
  PANE_RIGHT,
  renderTerminalView,
  type Status,
  TABS,
  TASKS,
  VIEW_HEIGHT,
  WIDTH,
  WINDOW_HEIGHT,
} from './terminal-view.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf } from './xml.ts';

const svg = renderTerminalView();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const number = (value: string | undefined): number => Number(value ?? Number.NaN);

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

/** How many marks the picture draws for a status: its class names the status. */
const marks = (status: Status): number => {
  const name = { working: 'working', 'needs-you': 'needs', 'not-started': 'open', done: 'done' }[status];
  return places.filter((place) => place.element.attributes.get('class') === name).length;
};

describe('renderTerminalView', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderTerminalView(), svg);
    assert.equal(root.name, 'svg');
    assert.equal(root.attributes.get('height'), String(VIEW_HEIGHT));
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.ok(label.startsWith('teamrig in your terminal: one window, one tab per session (lead, api, web, data, docs, tests). '), label);
    assert.ok(label.includes(' 1, data: Keep logs 30 days or 90? My pick: 30, it halves the storage. '), label);
    assert.ok(label.includes(' T14 Log retention, data, p2, due Thu, needs you. '), label);
    assert.ok(label.endsWith(' T11 Release notes, docs, p3, done.'), label);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('writes the tabs, the conversation, the pane and the key, in that order', () => {
    const decisions = DECISIONS.flatMap((decision, i) => [String(i + 1), decision.from, decision.ask, `My pick: ${decision.pick}`]);
    const rows = TASKS.flatMap((task) => [task.id, task.title, `${task.owner} · ${task.priority} · ${task.due}`]);
    assert.deepEqual(
      texts.map((found) => found.words),
      [
        ...TABS.map((tab) => tab.name),
        ...['>', ASK, OPENING, ...decisions, CLOSING, '>', ANSWER],
        ...['Tasks', 'teamrig-pane', ...rows],
        ...KEY_ORDER.map((status) => KEY[status]),
      ],
    );
  });

  it('tells one story: every task has a tab, and every decision comes from a tab that needs you', () => {
    const tabs = new Map(TABS.map((tab) => [tab.name, tab.status]));
    for (const task of TASKS) assert.ok(tabs.has(task.owner), task.owner);
    for (const decision of DECISIONS) assert.equal(tabs.get(decision.from), 'needs-you', decision.from);
    const waiting = TASKS.filter((task) => task.status === 'needs-you').map((task) => task.owner);
    assert.deepEqual(new Set(waiting), new Set(DECISIONS.map((decision) => decision.from)));
  });

  it('marks every tab, row and key entry as its status says', () => {
    for (const status of KEY_ORDER) {
      const expected = TABS.filter((tab) => tab.status === status).length + TASKS.filter((task) => task.status === status).length + 1;
      assert.equal(marks(status), expected, status);
    }
  });

  it('keeps each text in its place: tabs in their tab, the conversation left of the pane, the rows inside it', () => {
    for (const found of texts) {
      if (found.y < 44) {
        const tab = Math.floor((found.left - 12) / 96);
        assert.ok(found.right <= 12 + tab * 96 + 92, `tab text runs out of its tab: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT && found.left < DIVIDER_X) {
        assert.ok(found.right <= DIVIDER_X - 8, `conversation text runs into the pane: ${found.words}`);
      } else if (found.y < WINDOW_HEIGHT) {
        assert.ok(found.left >= PANE_LEFT && found.right <= PANE_RIGHT, `pane text leaves the pane: ${found.words}`);
      } else {
        assert.ok(found.y < VIEW_HEIGHT && found.right <= WIDTH, `key text leaves the picture: ${found.words}`);
      }
    }
  });

  it('opens its stylesheet with the theme, colours only with its tokens, and does not move', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
    assert.equal(animationsIn(css).size, 0);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
