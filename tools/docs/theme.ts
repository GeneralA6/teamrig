/**
 * The palette of the README's light-and-dark pictures (how it works, why, the plan and the growth picture): each
 * colour token has a value for GitHub's light theme and one for its dark theme, and the reader's colour scheme picks
 * the side. The hero and the commands screen are dark in either theme, as a terminal is, and keep their own palettes.
 */
import { SANS_FONTS } from './svg.ts';

/** The colour tokens, each with its light value and its dark value. */
export const TOKENS = {
  fg: ['#1f2328', '#e6edf3'],
  muted: ['#59636e', '#9198a1'],
  line: ['#d1d9e0', '#3d444d'],
  tile: ['#f6f8fa', '#151b23'],
  bg: ['#ffffff', '#0d1117'],
  purple: ['#8250df', '#a371f7'],
  /** Purple at about 13% on the page, opaque, so lines drawn behind a lead stay hidden. */
  tint: ['#f0eafb', '#221e36'],
  amber: ['#9a6700', '#d29922'],
  green: ['#1a7f37', '#3fb950'],
} as const satisfies Readonly<Record<string, readonly [light: string, dark: string]>>;

export type Token = keyof typeof TOKENS;

/** The tokens' declarations for one side: `--fg:#1f2328;--muted:...`. */
function declarations(side: 0 | 1): string {
  return Object.entries(TOKENS)
    .map(([name, values]) => `--${name}:${values[side]}`)
    .join(';');
}

/** The stylesheet lines every themed picture opens with: the light tokens, the dark tokens, and the text's font and colour. */
export function themeStyle(): string[] {
  return [`:root{${declarations(0)}}`, `@media (prefers-color-scheme:dark){:root{${declarations(1)}}}`, `text{font-family:${SANS_FONTS};fill:var(--fg)}`];
}
