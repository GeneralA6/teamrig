import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from './colour.ts';
import { renderHowItWorks, STEPS, TILES, TOKENS } from './how-it-works.ts';
import { animationsIn, ascending, keyframesIn, mediaIn, rulesIn } from './stylesheet.ts';
import { parseXml, placesIn, textOf } from './xml.ts';

const svg = renderHowItWorks();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');

/** A `--name:value;...` run as a map. */
const tokens = (declarations: string): Map<string, string> =>
  new Map(declarations.split(';').map((declaration): [string, string] => {
    const [name = '', value = ''] = declaration.split(':');
    return [name.replace(/^--/, ''), value];
  }));

const light = tokens(rulesIn(css).get(':root') ?? '');
const dark = tokens(rulesIn(mediaIn(css).get('(prefers-color-scheme:dark)') ?? '').get(':root') ?? '');

describe('renderHowItWorks', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderHowItWorks(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.match(label, /^How teamrig works: 1, say what you want/);
    assert.match(label, /What keeps the team on track: one owner per task/);
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('writes every step and tile, its title and its two lines', () => {
    const words = new Set(places.filter((place) => place.element.name === 'text').map((place) => textOf(place.element)));
    for (const card of [...STEPS, ...TILES]) for (const line of [card.title, ...card.lines]) assert.ok(words.has(line), line);
    assert.ok(['1', '2', '3', '4'].every((number) => words.has(number)));
  });

  it('defines every colour token it uses, once for a light colour scheme and once for a dark one', () => {
    const used = new Set([...css.matchAll(/var\(--([\w-]+)\)/g)].map((found) => found[1]));
    for (const name of used) assert.ok(name !== undefined && light.has(name) && dark.has(name), `--${name}`);
    for (const [name, [lightValue, darkValue]] of Object.entries(TOKENS)) {
      assert.deepEqual([light.get(name), dark.get(name)], [lightValue, darkValue], name);
    }
  });

  it('keeps its text readable on its own background and on a tile, in both colour schemes', () => {
    for (const scheme of [light, dark]) {
      const colour = (name: string): string => scheme.get(name) ?? '';
      for (const text of ['fg', 'muted']) {
        for (const ground of ['bg', 'tile']) {
          const ratio = contrast(colour(text), colour(ground));
          assert.ok(ratio >= 4.5, `${text} on ${ground}: ${ratio.toFixed(2)}`);
        }
      }
      assert.ok(contrast(colour('accent'), colour('bg')) >= 3, 'the icons and arrows stand out from the page');
      assert.ok(contrast('#ffffff', colour('accent')) >= 3, 'the step numbers read on their purple chip');
    }
  });

  it('paints its own background, full size, behind everything else', () => {
    const first = root.children.find((node) => typeof node !== 'string' && !['title', 'style'].includes(node.name));
    assert.ok(first !== undefined && typeof first !== 'string');
    assert.deepEqual([first.name, first.attributes.get('width'), first.attributes.get('height'), first.attributes.get('class')], ['rect', '960', '500', 'bg']);
    assert.equal(rulesIn(css).get('.bg'), 'fill:var(--bg)');
  });

  it('flows the arrows on keyframes, and stops them when the reader asks for reduced motion', () => {
    assert.deepEqual([...animationsIn(css)], [['.flow', 'flow']]);
    const stops = keyframesIn(css).get('flow')?.stops ?? [];
    assert.ok(stops.length > 0 && ascending(stops));
    assert.equal(mediaIn(css).get('(prefers-reduced-motion:reduce)'), '.flow{animation:none}');
    assert.equal(places.filter((place) => place.element.attributes.get('class') === 'flow').length, STEPS.length - 1);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
