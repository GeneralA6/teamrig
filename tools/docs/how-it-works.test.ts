import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHowItWorks, STEPS } from './how-it-works.ts';
import { animationsIn } from './stylesheet.ts';
import { themeStyle, TOKENS } from './theme.ts';
import { parseXml, placesIn, textOf } from './xml.ts';

const svg = renderHowItWorks();
const root = parseXml(svg);
const places = placesIn(root);
const css = textOf(places.find((place) => place.element.name === 'style')?.element ?? '');
const withClass = (cls: string): string[] => places.filter((place) => place.element.attributes.get('class') === cls).map((place) => place.element.name);

describe('renderHowItWorks', () => {
  it('draws the same bytes every time, as well-formed XML', () => {
    assert.equal(renderHowItWorks(), svg);
    assert.equal(root.name, 'svg');
  });

  it('names the picture for screen readers: role, aria-label and a matching title', () => {
    const label = root.attributes.get('aria-label') ?? '';
    assert.equal(root.attributes.get('role'), 'img');
    assert.equal(
      label,
      'How teamrig works: 1. Tell the lead, what you want, in plain words. 2. It hires a team, and gives each member a job. ' +
        '3. The team builds it, together, each in its own tab. 4. You get the result, the lead calls you back.',
    );
    assert.equal(textOf(places.find((place) => place.element.name === 'title')?.element ?? ''), label);
  });

  it('writes every step: its title and its line', () => {
    const words = places.filter((place) => place.element.name === 'text').map((place) => textOf(place.element));
    assert.deepEqual(words, STEPS.flatMap((step) => [step.title, ...step.lines]));
  });

  it('draws each step in purple and the last, the result, in green, joined by one arrow between steps', () => {
    assert.deepEqual(withClass('icon lead'), ['g', 'g', 'g']);
    assert.deepEqual(withClass('icon done'), ['g']);
    assert.deepEqual(withClass('halo done'), ['circle']);
    assert.equal(withClass('arrow').length, STEPS.length - 1);
  });

  it('opens its stylesheet with the theme, and colours only with its tokens', () => {
    assert.ok(css.trimStart().startsWith(themeStyle().join('\n')));
    for (const [, name = ''] of css.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(Object.hasOwn(TOKENS, name), `--${name}`);
  });

  it('does not move', () => {
    assert.equal(animationsIn(css).size, 0);
  });

  it('draws no pictographs (emoji)', () => {
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u);
  });
});
