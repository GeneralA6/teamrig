import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from './colour.ts';
import { renderWordmark, WORDMARK_COLOURS } from './wordmark.ts';

describe('renderWordmark', () => {
  const svg = renderWordmark();

  it('draws the same bytes every time', () => {
    assert.equal(renderWordmark(), svg);
  });

  it('names the picture for screen readers', () => {
    assert.match(svg, /role="img" aria-label="teamrig"/);
    assert.match(svg, /<title>teamrig<\/title>/);
  });

  it('draws a bold "team" and an accent "rig" in a monospace font', () => {
    assert.match(svg, /<tspan class="strong">team<\/tspan><tspan class="accent">rig<\/tspan>/);
    assert.match(svg, /\.strong\{[^}]*font-weight:700/);
    assert.match(svg, /font-family:[^;]*monospace/);
  });

  it('holds the word to the picture width, so no font overflows it', () => {
    const width = /width="(\d+)"/.exec(svg)?.[1];
    assert.ok(width !== undefined);
    assert.match(svg, new RegExp(`textLength="${width}"`));
  });

  it("reads as large text (contrast 3:1 or more) on GitHub's light and dark backgrounds in either colour scheme", () => {
    for (const colour of Object.values(WORDMARK_COLOURS)) {
      for (const background of ['#ffffff', '#0d1117']) {
        const ratio = contrast(colour, background);
        assert.ok(ratio >= 3, `${colour} on ${background}: ${ratio.toFixed(2)}`);
      }
    }
  });

  it('lifts "team" to a lighter grey under a dark colour scheme, and changes nothing else', () => {
    assert.ok(svg.includes(`@media (prefers-color-scheme:dark){.strong{fill:${WORDMARK_COLOURS.strongDark}}}`));
    assert.equal(svg.match(/prefers-color-scheme/g)?.length, 1);
  });
});
