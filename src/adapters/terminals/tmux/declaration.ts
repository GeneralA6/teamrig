import type { Support, TerminalDeclaration } from '../../../plugin-api/index.ts';

/** No row carries a proof yet: a proof is the record of a live run on the operating system it names. */
const SUPPORTED: Support = { kind: 'supported', proofs: [] };

/** tmux has a call for it; teamrig makes none yet. */
const NOT_ASKED: Support = { kind: 'unsupported', notice: 'teamrig does not ask tmux for it yet' };

/** tmux shows what a pane printed, never whether its session is in a turn, at a question or holds unsent text. */
const NO_STATE: Support = { kind: 'unsupported', notice: 'tmux cannot tell whether a pane is idle' };

/**
 * What teamrig does in tmux today: a pane is a tmux window named by its title (`new-window -n`), which is the id
 * teamrig finds it by again (`select-window -t`).
 */
export const declaration: TerminalDeclaration = {
  apiVersion: '0.1.0',
  id: 'tmux',
  name: 'tmux',
  manifest: {
    'pane.open': SUPPORTED,
    'pane.window': { kind: 'unsupported', notice: 'a pane opens in the tmux session teamrig runs in: teamrig names no other' },
    'pane.focus': SUPPORTED,
    'pane.close': NOT_ASKED,
    'pane.restart': NOT_ASKED,
    'pane.rename': NOT_ASKED,
    'pane.deliver': NO_STATE,
    'pane.is-idle': NO_STATE,
    'pane.list': NOT_ASKED,
    'pane.sees-draft': { kind: 'unsupported', notice: "tmux does not tell a pane's unsent input from what it printed" },
  },
};
