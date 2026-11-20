import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** Terminal's AppleScript can reach a window by its id; teamrig keeps none of the window it opened. */
const NOT_ASKED: Support = { kind: 'unsupported', notice: 'teamrig does not ask Terminal for it yet' };

const NO_STATE: Support = { kind: 'unsupported', notice: 'Terminal cannot tell whether a pane is idle' };

/**
 * What teamrig does in macOS Terminal today: a pane is a window opened by AppleScript's `do script`. The window is
 * handed no title, so teamrig has nothing to find it by again.
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'macos-terminal',
  name: 'macOS Terminal',
  manifest: {
    'pane.open': {
      kind: 'partial',
      missing: 'an id of the pane it opened',
      notice: 'the window opens with no title from teamrig, so teamrig cannot find it again',
      proofs: [],
    },
    'pane.window': { kind: 'unsupported', notice: 'every pane is a window of its own' },
    'pane.focus': NOT_ASKED,
    'pane.close': NOT_ASKED,
    'pane.restart': NOT_ASKED,
    'pane.rename': NOT_ASKED,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': NOT_ASKED,
    'pane.sees-draft': { kind: 'unsupported', notice: "Terminal cannot read a pane's input" },
  },
};
