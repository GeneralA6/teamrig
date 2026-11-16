# Brand colors

teamrig has two colors, the ones of the README's wordmark ([`../wordmark.svg`](../wordmark.svg)) and pictures. Every
logo and icon option uses only these two, plus transparent; the options differ in the mark, never in the colors.

| Color | Role | Light theme | Dark theme | Used for |
| --- | --- | --- | --- | --- |
| Purple | accent: the "rig" | `#8957e5` | `#a371f7` | the word "rig" (regular weight); in each mark, the rig that holds the team together |
| Gray | base: the "team" | `#6e7781` | `#8b949e` | the word "team" (bold); in each mark, the team's sessions |

- The dark values come in through `@media (prefers-color-scheme: dark)` in each SVG's `<style>`, as in the wordmark.
- An SVG in an `<img>` follows the viewer's system color scheme, not GitHub's theme, so either value can land on
  either page. All four reach a contrast of 3:1 or more on GitHub's light (`#ffffff`) and dark (`#0d1117`)
  backgrounds: gray 4.55 / 4.16 and 3.08 / 6.15, purple 4.61 / 4.11 and 3.35 / 5.64 (light value, then dark value;
  each on white / on dark).
- `preview-light.svg` and `preview-dark.svg` draw the icon and logo on GitHub's light (`#ffffff`) and dark
  (`#0d1117`) page colors, with the light or dark values fixed. Those two backgrounds are preview only, not brand
  colors.
- `icon-mono.svg` uses neither: every fill and stroke is `currentColor`, for one-color places.
