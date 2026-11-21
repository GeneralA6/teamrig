import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** `konsole --new-tab` opens a tab and answers nothing of it; teamrig makes no later call to that tab. */
const NOT_ASKED: Support = { kind: 'unsupported', notice: 'teamrig does not ask Konsole for it yet' };

const NO_STATE: Support = { kind: 'unsupported', notice: 'Konsole cannot tell whether a pane is idle' };

/**
 * What teamrig does in Konsole today: a pane is a tab opened in the session's folder. The tab is handed no title,
 * so teamrig has nothing to find it by again.
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'konsole',
  name: 'Konsole',
  manifest: {
    'pane.open': {
      kind: 'partial',
      missing: 'an id of the pane it opened',
      notice: 'the tab opens with no title from teamrig, so teamrig cannot find it again',
      proofs: [],
    },
    'pane.window': { kind: 'unsupported', notice: 'a pane opens in the window Konsole picks: teamrig names none' },
    'pane.focus': NOT_ASKED,
    'pane.close': NOT_ASKED,
    'pane.restart': NOT_ASKED,
    'pane.rename': NOT_ASKED,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': NOT_ASKED,
    'pane.sees-draft': { kind: 'unsupported', notice: "Konsole cannot read a pane's input" },
  },
};
