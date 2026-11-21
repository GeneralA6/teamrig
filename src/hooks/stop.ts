import type { HookReply } from '../ports/host/index.ts';
import type { StopDecision } from '../refresh/decide.ts';

/** The lines for the human as one notice, a line each, or none when there are none. */
function noticeOf(lines: readonly string[]): string | undefined {
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** A block that keeps the session going with `reason` as its next instruction, the `notices` shown to the human with it. */
export function blockReply(reason: string, notices: readonly string[] = []): HookReply {
  return { verdict: { kind: 'block', reason }, notice: noticeOf(notices) };
}

/**
 * The reply at a turn's end for a refresh decision and the model `notices` for the human. A block keeps
 * the session going with the reason as its next instruction; a notice shows the human one line and,
 * when the team wants it, marks the tab; the model notices are shown with either, or alone. `tabTitle`
 * (tab status) sets the tab's title at any end but a block's, over a notice's own. A turn with none of
 * them answers a reply that says nothing, which prints nothing, so it costs no context.
 */
export function stopReply(decision: StopDecision, notices: readonly string[] = [], tabTitle?: string): HookReply {
  switch (decision.kind) {
    case 'block':
      return blockReply(decision.reason, notices);
    case 'notice':
      return { notice: noticeOf([decision.message, ...notices]), tabTitle: tabTitle ?? decision.title };
    case 'none':
    case 'measure':
    case 'write':
      return { notice: noticeOf(notices), tabTitle };
  }
}
