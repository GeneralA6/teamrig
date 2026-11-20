import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** `gnome-terminal --tab` opens a tab and answers nothing of it: no later call reaches that tab. */
const NO_CALL: Support = { kind: 'unsupported', notice: 'GNOME Terminal has no call for it on a tab already open' };

const NO_STATE: Support = { kind: 'unsupported', notice: 'GNOME Terminal cannot tell whether a pane is idle' };

/**
 * What teamrig does in GNOME Terminal today: a pane is a tab opened in the session's folder. The tab is handed no
 * title, so teamrig has nothing to find it by again.
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'gnome-terminal',
  name: 'GNOME Terminal',
  manifest: {
    'pane.open': {
      kind: 'partial',
      missing: 'an id of the pane it opened',
      notice: 'the tab opens with no title from teamrig, so teamrig cannot find it again',
      proofs: [],
    },
    'pane.window': { kind: 'unsupported', notice: 'a pane opens in the window GNOME Terminal picks: teamrig names none' },
    'pane.focus': NO_CALL,
    'pane.close': NO_CALL,
    'pane.restart': NO_CALL,
    'pane.rename': NO_CALL,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': NO_CALL,
    'pane.sees-draft': { kind: 'unsupported', notice: "GNOME Terminal cannot read a pane's input" },
  },
};
