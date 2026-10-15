import type { StopDecision } from '../refresh/decide.ts';

/** The xterm sequence that sets the terminal tab's title (OSC 0, ended by BEL). */
export function tabTitleSequence(title: string): string {
  return `\u001b]0;${title}\u0007`;
}

/** The user-facing lines as one `systemMessage`, or nothing when there are none. */
function messageOf(lines: readonly string[]): { readonly systemMessage?: string } {
  return lines.length === 0 ? {} : { systemMessage: lines.join('\n') };
}

/**
 * The Stop hook's stdout for a refresh decision and the model `notices` for the user. A block keeps
 * the session going with the reason as its next instruction; a notice shows the user one line and,
 * when the team wants it, marks the tab; the model notices are shown with either, or alone. A turn
 * with neither prints nothing, so it costs no context.
 */
export function stopOutput(decision: StopDecision, notices: readonly string[] = []): string {
  switch (decision.kind) {
    case 'block':
      return JSON.stringify({ decision: 'block', reason: decision.reason, ...messageOf(notices) });
    case 'notice':
      return JSON.stringify({
        ...messageOf([decision.message, ...notices]),
        ...(decision.title === undefined ? {} : { terminalSequence: tabTitleSequence(decision.title) }),
      });
    case 'none':
    case 'measure':
    case 'write':
      return notices.length === 0 ? '' : JSON.stringify(messageOf(notices));
  }
}
