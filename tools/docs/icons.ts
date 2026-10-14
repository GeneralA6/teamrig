/**
 * Line icons on a 24-unit grid, drawn with no colour of their own: the `icon` class of the picture that places them
 * sets the stroke, so one icon reads in light and dark.
 */

export const ICON_NAMES = ['say', 'lead', 'team', 'done', 'list', 'note', 'rules', 'shield', 'fresh', 'local'] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** The grid each icon is drawn on. */
export const ICON_GRID = 24;

const ICONS: Readonly<Record<IconName, string>> = {
  /** A speech bubble: say what you want. */
  say: '<path d="M4 4.5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M7 9.5h10M7 13h6"/>',
  /** One node over three: the lead plans for the team. */
  lead: '<circle cx="12" cy="5" r="2.6"/><circle cx="4.5" cy="19" r="2.2"/><circle cx="12" cy="19" r="2.2"/><circle cx="19.5" cy="19" r="2.2"/><path d="M12 7.6V16.8M10.6 7.2 5.6 17M13.4 7.2l5 9.8"/>',
  /** Two windows: sessions in their own tabs. */
  team: '<rect x="2.5" y="8" width="13" height="12" rx="2"/><path d="M6 8V5.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H15.5"/><path d="M5.5 12.5h7M5.5 16h4.5"/>',
  /** A ticked circle: the result. */
  done: '<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.6"/>',
  /** A checklist: the shared task list. */
  list: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11"/><circle cx="5" cy="18" r="1.6"/>',
  /** An envelope: notes between sessions. */
  note: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="m3 6.5 9 6.5 9-6.5"/>',
  /** A page of lines: the team's rules. */
  rules: '<path d="M6 2.5h9l4 4v15H6z"/><path d="M15 2.5v4h4M9 11h7M9 14.5h7M9 18h4"/>',
  /** A ticked shield: safe pushes. */
  shield: '<path d="M12 2.5 20 5.5v6c0 5-3.4 8.8-8 10-4.6-1.2-8-5-8-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  /** A circular arrow: a fresh context. */
  fresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5v5h-5"/>',
  /** A laptop: everything on your machine. */
  local: '<rect x="4" y="4.5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20M9 19.5l.6-2h4.8l.6 2"/>',
};

/** The icon with its top-left corner at (x, y), scaled to `size` pixels square. */
export function icon(name: IconName, x: number, y: number, size: number): string {
  return `<g transform="translate(${x} ${y}) scale(${size / ICON_GRID})" class="icon">${ICONS[name]}</g>`;
}
