import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from './colour.ts';
import { themeStyle, TOKENS, type Token } from './theme.ts';
import { mediaIn, rulesIn } from './stylesheet.ts';

const css = themeStyle().join('\n');

/** A `--name:value;...` run as a map. */
const tokens = (declarations: string): Map<string, string> =>
  new Map(
    declarations.split(';').map((declaration): [string, string] => {
      const [name = '', value = ''] = declaration.split(':');
      return [name.replace(/^--/, ''), value];
    }),
  );

const SCHEMES = [
  ['light', 0],
  ['dark', 1],
] as const;
const colour = (name: Token, side: 0 | 1): string => TOKENS[name][side];

describe('themeStyle', () => {
  it('sets every token for a light colour scheme, then again for a dark one', () => {
    const light = tokens(rulesIn(css).get(':root') ?? '');
    const dark = tokens(rulesIn(mediaIn(css).get('(prefers-color-scheme:dark)') ?? '').get(':root') ?? '');
    for (const [name, [lightValue, darkValue]] of Object.entries(TOKENS)) {
      assert.deepEqual([light.get(name), dark.get(name)], [lightValue, darkValue], name);
    }
    assert.equal(light.size, Object.keys(TOKENS).length);
  });

  it('writes text in the sans-serif stack, in the foreground colour', () => {
    assert.match(rulesIn(css).get('text') ?? '', /^font-family:-apple-system,.*;fill:var\(--fg\)$/);
  });
});

describe('TOKENS', () => {
  for (const [scheme, side] of SCHEMES) {
    it(`keeps text readable on the page, a tile and a purple tint, in a ${scheme} colour scheme`, () => {
      for (const text of ['fg', 'muted'] as const) {
        for (const ground of ['bg', 'tile', 'tint'] as const) {
          const ratio = contrast(colour(text, side), colour(ground, side));
          assert.ok(ratio >= 4.5, `${text} on ${ground}: ${ratio.toFixed(2)}`);
        }
      }
    });

    it(`makes the purple, amber and green marks stand out from the page in a ${scheme} colour scheme`, () => {
      for (const mark of ['purple', 'amber', 'green'] as const) {
        const ratio = contrast(colour(mark, side), colour('bg', side));
        assert.ok(ratio >= 3, `${mark} on bg: ${ratio.toFixed(2)}`);
      }
    });
  }
});
