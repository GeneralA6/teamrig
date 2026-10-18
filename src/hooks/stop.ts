import type { StopDecision } from '../refresh/decide.ts';

/** The xterm sequence that sets the terminal tab's title (OSC 0, ended by BEL). */
export function tabTitleSequence(title: string): string {
  return `\u001b]0;${title}\u0007`;
}

/** The user-facing lines as one `systemMessage`, or nothing when there are none. */
function messageOf(lines: readonly string[]): { readonly systemMessage?: string } {
  return lines.length === 0 ? {} : { systemMessage: lines.join('\n') };
}

/** A block that keeps the session going with `reason` as its next instruction, the `notices` shown to the user with it. */
export function blockOutput(reason: string, notices: readonly string[] = []): string {
  return JSON.stringify({ decision: 'block', reason, ...messageOf(notices) });
}

/** The output field that sets the tab's title, or nothing without a title. */
function titleOf(title: string | undefined): { readonly terminalSequence?: string } {
  return title === undefined ? {} : { terminalSequence: tabTitleSequence(title) };
}

/**
 * The Stop hook's stdout for a refresh decision and the model `notices` for the user. A block keeps
 * the session going with the reason as its next instruction; a notice shows the user one line and,
 * when the team wants it, marks the tab; the model notices are shown with either, or alone. `tabTitle`
 * (tab status) sets the tab's title at any end but a block's, over a notice's own. A turn with none of
 * them prints nothing, so it costs no context.
 */
export function stopOutput(decision: StopDecision, notices: readonly string[] = [], tabTitle?: string): string {
  switch (decision.kind) {
    case 'block':
      return blockOutput(decision.reason, notices);
    case 'notice':
      return JSON.stringify({ ...messageOf([decision.message, ...notices]), ...titleOf(tabTitle ?? decision.title) });
    case 'none':
    case 'measure':
    case 'write':
      return notices.length === 0 && tabTitle === undefined ? '' : JSON.stringify({ ...messageOf(notices), ...titleOf(tabTitle) });
  }
}
