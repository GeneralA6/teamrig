import type { StopDecision } from '../refresh/decide.ts';

/** The xterm sequence that sets the terminal tab's title (OSC 0, ended by BEL). */
export function tabTitleSequence(title: string): string {
  return `\u001b]0;${title}\u0007`;
}

/**
 * The Stop hook's stdout for a decision. A block keeps the session going with the reason as its
 * next instruction; a notice shows the user one line and, when the team wants it, marks the tab.
 * Every other decision prints nothing, so a turn without a refresh costs no context.
 */
export function stopOutput(decision: StopDecision): string {
  switch (decision.kind) {
    case 'block':
      return JSON.stringify({ decision: 'block', reason: decision.reason });
    case 'notice':
      return JSON.stringify({
        systemMessage: decision.message,
        ...(decision.title === undefined ? {} : { terminalSequence: tabTitleSequence(decision.title) }),
      });
    case 'none':
    case 'measure':
    case 'write':
      return '';
  }
}
