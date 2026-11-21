import type { TerminalGroup } from '../feature.ts';

/**
 * What a terminal does with the panes its sessions run in: a row per request of the terminal protocol, and one for
 * what it sees of a pane's input. A terminal without a row's request answers it `unserved`; one with no named
 * windows opens a pane wherever it opens one.
 */
export const PANE_FEATURES = {
  'pane.open': { doc: 'opens a pane for a session and answers its own id of it', byDefault: 'on' },
  'pane.window': { doc: 'opens a pane in the window teamrig names, made when none of that name is open', byDefault: 'on' },
  'pane.focus': { doc: "brings a session's pane forward", byDefault: 'on' },
  'pane.close': { doc: "closes a session's pane", byDefault: 'on' },
  'pane.restart': { doc: "restarts a pane's command, resuming the conversation when asked", byDefault: 'on' },
  'pane.rename': { doc: "changes a pane's title", byDefault: 'on' },
  'pane.deliver': { doc: 'delivers a wake only to an idle pane, with its token; else says what held it', byDefault: 'on' },
  'pane.is-idle': { doc: 'says whether a pane is idle, busy, asking, holding a draft or gone', byDefault: 'on' },
  'pane.list': { doc: 'lists every pane it has, each with its state and its identity label', byDefault: 'on' },
  'pane.sees-draft': { doc: "sees a pane's unsent input, so a wake never lands on a person's text", byDefault: 'on' },
} as const satisfies TerminalGroup<'pane'>;
