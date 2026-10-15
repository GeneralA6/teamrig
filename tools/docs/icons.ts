/**
 * Line icons on a 24-unit grid, drawn with no colour of their own: the class the placing picture gives them sets the
 * stroke, so one icon reads in light and dark. Also the step or card each icon heads in the README's pictures.
 */

export const ICON_NAMES = ['say', 'hire', 'build', 'done', 'plan', 'sun', 'learn', 'fresh', 'proof', 'terminal'] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** The grid each icon is drawn on. */
export const ICON_GRID = 24;

const ICONS: Readonly<Record<IconName, string>> = {
  /** A speech bubble: tell the lead what you want. */
  say: '<path d="M4 4.5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M7 9.5h10M7 13h6"/>',
  /** One node over three: the lead hires a team. */
  hire: '<circle cx="12" cy="5" r="2.6"/><circle cx="4.5" cy="19" r="2.2"/><circle cx="12" cy="19" r="2.2"/><circle cx="19.5" cy="19" r="2.2"/><path d="M12 7.6V16.8M10.6 7.2 5.6 17M13.4 7.2l5 9.8"/>',
  /** Two windows: the members build, each in its own tab. */
  build: '<rect x="2.5" y="8" width="13" height="12" rx="2"/><path d="M6 8V5.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H15.5"/><path d="M5.5 12.5h7M5.5 16h4.5"/>',
  /** A ticked circle: the result. */
  done: '<circle cx="12" cy="12" r="9.5"/><path d="m7.5 12.3 3 3 6-6.6"/>',
  /** A ticked calendar: your week, planned. */
  plan: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="m8.5 15 2.5 2.5 4.5-5"/>',
  /** The sun over the horizon: one meeting in the morning, then the day is yours. */
  sun: '<path d="M2.5 18h19M7 21.5h10"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 10.5V8M17.3 12.7l1.8-1.8M6.7 12.7l-1.8-1.8"/>',
  /** A light bulb: what one member learns, the team reuses. */
  learn: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  /** Two turning arrows: a session comes back where it left off. */
  fresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9l2.2-2.4"/><path d="M20.5 20.5v-5h-5"/>',
  /** A ticked clipboard: a project manager, where done means proven. */
  proof: '<rect x="4.5" y="4" width="15" height="17.5" rx="2"/><path d="M9 4V2.5h6V4"/><path d="m8.5 13 2.5 2.5 4.5-5"/>',
  /** A terminal window and its prompt: teamrig runs in the terminal you already have. */
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m6.5 9.5 3 2.5-3 2.5M11.5 15h5"/>',
};

/** A step or a card in a picture: its icon, its title and the short lines under it. */
export interface Card {
  readonly icon: IconName;
  readonly title: string;
  readonly lines: readonly string[];
}

/** The icon with its top-left corner at (x, y), scaled to `size` pixels square, in the class `cls` that colours it. */
export function icon(name: IconName, x: number, y: number, size: number, cls: string): string {
  return `<g transform="translate(${x} ${y}) scale(${size / ICON_GRID})" class="${cls}">${ICONS[name]}</g>`;
}
