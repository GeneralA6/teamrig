import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** No row carries a proof yet: a proof is the record of a live run on the operating system it names. */
const SUPPORTED: Support = { kind: 'supported', proofs: [] };

/** Windows Terminal's command line opens tabs and windows; it has no call that acts on a tab already open. */
const NO_CALL: Support = { kind: 'unsupported', notice: 'Windows Terminal has no call for it on a tab already open' };

const NO_STATE: Support = { kind: 'unsupported', notice: 'Windows Terminal cannot tell whether a pane is idle' };

/**
 * What teamrig does in Windows Terminal today: a pane is a tab opened by `wt.exe new-tab --title`, in the window
 * teamrig names (`-w`), and its title is the id teamrig finds it by again, through UI Automation, to bring it forward.
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'windows-terminal',
  name: 'Windows Terminal',
  manifest: {
    'pane.open': SUPPORTED,
    'pane.window': SUPPORTED,
    'pane.focus': SUPPORTED,
    'pane.close': NO_CALL,
    'pane.restart': NO_CALL,
    'pane.rename': NO_CALL,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': { kind: 'unsupported', notice: 'teamrig does not ask Windows Terminal for its tabs yet' },
    'pane.sees-draft': { kind: 'unsupported', notice: "Windows Terminal cannot read a pane's input" },
  },
};
