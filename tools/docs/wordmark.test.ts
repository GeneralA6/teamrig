import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderWordmark, WORDMARK_COLOURS } from './wordmark.ts';

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

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

  it("reads as large text (contrast 3:1 or more) on GitHub's light and dark backgrounds, with no theme switch", () => {
    for (const colour of Object.values(WORDMARK_COLOURS)) {
      for (const background of ['#ffffff', '#0d1117']) {
        const ratio = contrast(colour, background);
        assert.ok(ratio >= 3, `${colour} on ${background}: ${ratio.toFixed(2)}`);
      }
    }
    assert.doesNotMatch(svg, /prefers-color-scheme/);
  });

  it('measures contrast the WCAG way', () => {
    assert.equal(contrast('#000000', '#ffffff'), 21);
    assert.equal(contrast('#777777', '#777777'), 1);
  });
});
