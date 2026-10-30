import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME } from '../../core/home.ts';
import { sendTargetOf, sendTextOf } from '../../hooks/cold-send.ts';
import { refusalOutput } from '../../hooks/permission.ts';
import { indexMarks, RECEIVER_TABS, tabsOf } from '../../inbox/marks.ts';
import { closedOf, SessionLog } from '../../sessions/log.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { postUrgentLine } from '../urgent-line.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * The closed-send hold for a SendMessage call (T1100), as the hook's stdout; undefined lets the message go. A message
 * to a session teamrig closed reaches no tab, so while the idle pass reopens sessions (`open.idle.mode` on) the hook
 * posts it as the receiver's urgent line instead, which the pass reopens it for, with the line quoted in its first
 * prompt, and denies the send with that said. It lets go: modes off and dry-run (no pass reopens, so the failed
 * send's hint stands), a receiver that is not a team session, the sender's own session, one not closed, one whose tab
 * was started by hand since its close (its session record is newer), and a message with no text (an idle
 * subscription). With wakes on, the denial also names `inbox add --wake now`, which posts the same ask, so the sender
 * posts such a line itself next time.
 */
export async function closedSendHold(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown, claudeSession: string): Promise<string | undefined> {
  const to = sendTargetOf(payload);
  const text = sendTextOf(payload).trim();
  if (config.open.idle.mode !== 'on' || to === undefined || text === '') {
    return undefined;
  }
  const receiver = roster.lookup(to);
  if (!receiver.ok) {
    return undefined;
  }
  const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
  if (tabsOf(marks, receiver.id, RECEIVER_TABS).includes(claudeSession)) {
    return undefined;
  }
  const closed = closedOf((await new SessionLog(runtime.files, kit.paths.sessionLog).read()).records, receiver.id);
  if (closed === undefined) {
    return undefined;
  }
  const started = await new SessionRecordStore(runtime.files, kit.paths).read(receiver.id);
  if (started !== undefined && Date.parse(started.at) > Date.parse(closed.at)) {
    return undefined;
  }
  const from = indexMarks(marks).areaBySession.get(claudeSession) ?? KIT_NAME;
  const at = teamZone(config, runtime).clock(new Date(closed.at));
  // A home close (T1364) is of a session hired with no room, which never ran.
  const state = closed.claudeSession === undefined ? `home (${closed.by} hired it at ${at} with no room on the host)` : `closed (${closed.by} closed it at ${at})`;
  const why = `${roster.nameOf(receiver.id) ?? receiver.id} is ${state}, so this message cannot reach it`;
  const unposted = await postUrgentLine(runtime, kit, config, { to: receiver.id, from, text });
  const line = `${KIT_NAME} inbox add --to ${receiver.id} --text "..."${config.wake.enabled ? ' --wake now' : ''}`;
  return refusalOutput(
    unposted === undefined
      ? `${why}; ${KIT_NAME} posted it as an urgent line in its inbox, and the idle pass reopens it within about a minute with the line quoted in its first prompt. Do not send it again.` +
          (config.wake.enabled ? ` Next time post it yourself: ${line}.` : '')
      : `${why}, and ${KIT_NAME} could not post it as an urgent line: ${unposted}. Tell the lead the urgent line failed; unless that says it is in the inbox, leave it with ${line} once that is fixed.`,
  );
}
