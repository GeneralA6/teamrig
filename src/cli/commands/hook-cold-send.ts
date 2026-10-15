import { claudeProjectsDir, lastWriteOf } from '../../budget/discover.ts';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { decideColdSend, holdOutput, JsonlColdSendLog, sendTargetOf } from '../../hooks/cold-send.ts';
import { indexMarks, type InboxMark } from '../../inbox/marks.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/** How many of a session's latest tabs are checked for its last activity: a restart leaves the old tab's marks behind. */
export const RECEIVER_TABS = 5;

/** The Claude Code sessions that are `area` now, newest first: those whose latest inbox read or binding named it. */
export function tabsOf(marks: readonly InboxMark[], area: string, limit: number): string[] {
  const { areaBySession } = indexMarks(marks);
  const tabs: string[] = [];
  for (const mark of [...marks].reverse()) {
    if (tabs.length >= limit) {
      break;
    }
    const tab = mark.claudeSession;
    if (tab !== null && areaBySession.get(tab) === area && !tabs.includes(tab)) {
      tabs.push(tab);
    }
  }
  return tabs;
}

/**
 * The cold-send hold for a SendMessage call, as the hook's stdout; undefined lets the message go: a
 * receiver that is not a team session (a helper, a pipe), the sender's own session, a receiver with
 * no transcript yet, or one active within `messages.coldAfterMinutes`. Idle time runs from the
 * receiver's last write to its own transcript, never its subagents': their work does not keep the
 * receiver's context cached.
 */
export async function coldSendHold(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown, claudeSession: string): Promise<string | undefined> {
  const to = sendTargetOf(payload);
  const { coldAfterMinutes } = config.messages;
  if (to === undefined || coldAfterMinutes === 0) {
    return undefined;
  }
  const receiver = roster.lookup(to);
  if (!receiver.ok) {
    return undefined;
  }
  const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
  const tabs = tabsOf(marks, receiver.id, RECEIVER_TABS);
  if (tabs.includes(claudeSession)) {
    return undefined;
  }
  const last = await lastWriteOf(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), tabs);
  if (last === undefined) {
    return undefined;
  }
  const now = runtime.clock.now();
  const verdict = await decideColdSend(new JsonlColdSendLog(runtime.files, kit.paths.coldSends), {
    claudeSession,
    to: receiver.id,
    name: roster.nameOf(receiver.id) ?? receiver.id,
    idleMs: now - last,
    coldAfterMinutes,
    now: new Date(now),
    command: KIT_NAME,
  });
  return verdict.kind === 'hold' ? holdOutput(verdict.reason) : undefined;
}
