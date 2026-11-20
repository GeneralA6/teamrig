import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** No row carries a proof yet: a proof is the record of a live run on the operating system it names. */
const SUPPORTED: Support = { kind: 'supported', proofs: [] };

/** `x-terminal-emulator` is whichever terminal the system names, started by the two flags they share: nothing reaches a window once open. */
const NO_CALL: Support = { kind: 'unsupported', notice: 'the terminal has no call for it on a window already open' };

const NO_STATE: Support = { kind: 'unsupported', notice: 'the terminal cannot tell whether a pane is idle' };

/**
 * What teamrig does through `x-terminal-emulator` today: a pane is a new window titled by `-T`, and that title is
 * all teamrig knows it by.
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'x-terminal-emulator',
  name: 'x-terminal-emulator',
  manifest: {
    'pane.open': SUPPORTED,
    'pane.window': { kind: 'unsupported', notice: 'every pane is a window of its own' },
    'pane.focus': NO_CALL,
    'pane.close': NO_CALL,
    'pane.restart': NO_CALL,
    'pane.rename': NO_CALL,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': NO_CALL,
    'pane.sees-draft': { kind: 'unsupported', notice: "the terminal cannot read a pane's input" },
  },
};
