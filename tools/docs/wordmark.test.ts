import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from './colour.ts';
import { renderWordmark, WORDMARK_COLOURS } from './wordmark.ts';
import { WORDMARK_GLYPHS } from './wordmark-glyphs.ts';

const PATH_DATA = /^[MLQCZ0-9. -]+$/;

describe('renderWordmark', () => {
  const svg = renderWordmark();

  it('draws the same bytes every time', () => {
    assert.equal(renderWordmark(), svg);
  });

  it('names the picture for screen readers', () => {
    assert.match(svg, /role="img" aria-label="teamrig"/);
    assert.match(svg, /<title>teamrig<\/title>/);
  });

  it('draws "team" in the base colour and "rig" in the accent as paths, with no text or font for a system to swap', () => {
    assert.ok(svg.includes(`<path class="base" d="${WORDMARK_GLYPHS.team}"/>`));
    assert.ok(svg.includes(`<path class="accent" d="${WORDMARK_GLYPHS.rig}"/>`));
    assert.doesNotMatch(svg, /<text|font-family|font-weight/);
  });

  it('holds plain path data, and the picture is as wide as the word', () => {
    assert.match(WORDMARK_GLYPHS.team, PATH_DATA);
    assert.match(WORDMARK_GLYPHS.rig, PATH_DATA);
    assert.match(svg, new RegExp(`width="${WORDMARK_GLYPHS.width}" height="42" viewBox="0 0 ${WORDMARK_GLYPHS.width} 42"`));
  });

  it("reads as large text (contrast 3:1 or more) on GitHub's light and dark backgrounds in either colour scheme", () => {
    for (const colour of Object.values(WORDMARK_COLOURS)) {
      for (const background of ['#ffffff', '#0d1117']) {
        const ratio = contrast(colour, background);
        assert.ok(ratio >= 3, `${colour} on ${background}: ${ratio.toFixed(2)}`);
      }
    }
  });

  it('lifts both colours a step under a dark colour scheme, and changes nothing else', () => {
    assert.ok(
      svg.includes(
        `@media (prefers-color-scheme:dark){.base{fill:${WORDMARK_COLOURS.baseDark}}.accent{fill:${WORDMARK_COLOURS.accentDark}}}`,
      ),
    );
    assert.equal(svg.match(/prefers-color-scheme/g)?.length, 1);
  });
});
