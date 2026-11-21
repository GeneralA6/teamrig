/**
 * The README's name, drawn as the brand logo's two-tone word: a regular grey "team" and a bold accent "rig", in Open
 * Sans drawn as paths (./wordmark-glyphs.ts), so every system shows the same letters.
 * An SVG in an <img> follows the viewer's OS colour scheme, not GitHub's theme, so a dark-mode colour inside it can
 * land on a light page. Every colour, the dark scheme's included, is a mid-tone that reads on both of GitHub's
 * backgrounds; the dark scheme lifts each a step, as the brand logo does.
 */
import { WORDMARK_GLYPHS } from './wordmark-glyphs.ts';

const NAME = 'teamrig';
const HEIGHT = 42;

/** The brand palette (docs/images/brand/colors.md), each readable as large text on white and on GitHub's dark page. */
export const WORDMARK_COLOURS = {
  base: '#6e7781',
  baseDark: '#8b949e',
  accent: '#8957e5',
  accentDark: '#a371f7',
} as const;

export function renderWordmark(): string {
  const width = WORDMARK_GLYPHS.width;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${NAME}">`,
    `<title>${NAME}</title>`,
    '<style>',
    `.base{fill:${WORDMARK_COLOURS.base}}`,
    `.accent{fill:${WORDMARK_COLOURS.accent}}`,
    `@media (prefers-color-scheme:dark){.base{fill:${WORDMARK_COLOURS.baseDark}}.accent{fill:${WORDMARK_COLOURS.accentDark}}}`,
    '</style>',
    `<path class="base" d="${WORDMARK_GLYPHS.team}"/>`,
    `<path class="accent" d="${WORDMARK_GLYPHS.rig}"/>`,
    '</svg>',
    '',
  ].join('\n');
}
