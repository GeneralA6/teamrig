# teamrig logo and icon

<img src="logo.svg" width="360" alt="teamrig logo">

**Idea:** a frame holding three tiled panes, one tall and two stacked: the sessions of a team laid out side by side
in one rig, as they run in a terminal. The tall pane is the lead, and two bridges link it to the two team panes it
runs.

**Colors** ([palette](colors.md)): purple for the rig: the frame, the lead pane and its bridges; gray for the two team
panes. The word "teamrig" matches the README's wordmark: Open Sans, "team" gray and regular, "rig" purple and bold,
drawn as paths (Open Sans 3.003, SIL Open Font License 1.1), so it looks the same on every system and needs no font.

**Plain text:** ◫ (a square split into panes)

## On light and dark

The icon at 16, 32 and 128 px, then the logo, on GitHub's light and dark backgrounds, whatever your theme:

<img src="preview-light.svg" width="720" alt="teamrig icon at 16, 32 and 128 px and logo on a light background">
<img src="preview-dark.svg" width="720" alt="teamrig icon at 16, 32 and 128 px and logo on a dark background">

The previews hold fixed colors: the light values on a light background, the dark values on a dark one, with no
color-scheme switch. Their backgrounds, `#ffffff` and `#0d1117`, are GitHub's page colors, there for the preview
only; they are not brand colors. The brand files themselves follow the viewer's system color scheme, and the light
and dark values each meet both backgrounds.

## Files

- [`logo.svg`](logo.svg): the mark beside the word, 480 x 128.
- [`icon.svg`](icon.svg): the mark alone, 64 x 64, two colors, no line thinner than 4 units; drawn on a 4-unit grid,
  so at 16 px the frame and the gaps between the panes are each one whole pixel.
- [`icon-16.svg`](icon-16.svg): the mark drawn for 16 px, its bridges twice as tall (8 units, two whole pixels), so they
  still show at that size; the previews use it for their 16 px icon.
- [`icon-mono.svg`](icon-mono.svg): the same mark in one color, every fill and stroke `currentColor`.
- [`colors.md`](colors.md): the palette.
- [`preview-light.svg`](preview-light.svg), [`preview-dark.svg`](preview-dark.svg): the pictures above.
