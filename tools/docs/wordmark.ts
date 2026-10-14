/**
 * The README's name, drawn as a two-tone monospace wordmark: a bold "team" and a lighter accent "rig".
 * An SVG in an <img> follows the viewer's OS colour scheme, not GitHub's theme, so a dark-mode switch inside it can
 * hide the word on a light page. Its colours are instead mid-tones that read on both of GitHub's backgrounds.
 */

const WORD = { strong: 'team', accent: 'rig' } as const;
const FONT_SIZE = 34;
/** A monospace glyph is about 0.6 em wide; `textLength` holds the word to exactly this, whatever font draws it. */
const CHAR_WIDTH = FONT_SIZE * 0.6;
const HEIGHT = 42;
const BASELINE = 32;

/** GitHub's muted grey and purple, each readable as large text on white and on GitHub's dark background. */
export const WORDMARK_COLOURS = { strong: '#6e7781', accent: '#8957e5' } as const;

export function renderWordmark(): string {
  const name = `${WORD.strong}${WORD.accent}`;
  const width = Math.round(name.length * CHAR_WIDTH);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${name}">`,
    `<title>${name}</title>`,
    '<style>',
    `text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT_SIZE}px}`,
    `.strong{fill:${WORDMARK_COLOURS.strong};font-weight:700}`,
    `.accent{fill:${WORDMARK_COLOURS.accent};font-weight:400}`,
    '</style>',
    `<text x="0" y="${BASELINE}" textLength="${width}" lengthAdjust="spacingAndGlyphs"><tspan class="strong">${WORD.strong}</tspan><tspan class="accent">${WORD.accent}</tspan></text>`,
    '</svg>',
    '',
  ].join('\n');
}
