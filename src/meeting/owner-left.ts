import type { Files } from '../core/files.ts';
import { KIT_NAME } from '../core/home.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';

/**
 * Whether the owner is still in a meeting a `meeting end` would end (#921): a turn teamrig started (a reopen note, a
 * wake) must not end a meeting while the owner prompted in its tab under `meeting.ownerLeftMinutes` ago. The owner's
 * own turn ends it at once, as the owner asked; so does a turn of no tab (a terminal's own command line), which no
 * prompt of teamrig's started. Who prompted comes from the tabs' restore entries, which the prompt hook stamps by the
 * mark teamrig sets on the prompts it submits (src/restore/prompt-marks.ts).
 */

/** The meeting's tab: the team session it is held with, and whether the caller is that session. */
export interface MeetingTab {
  readonly team: string;
  readonly session: string;
  readonly callerIsMet: boolean;
}

/**
 * When the owner last prompted in the meeting's tab: the latest stamp of any tab the meeting's session ran in (a
 * context refresh or a reopen in a fresh Claude Code session is the same meeting tab), and of the caller's own tab
 * when it is that session, though its entry names no session (a tab bound by hand). Undefined when none has one.
 */
export function ownerPromptAtOf(entries: readonly RestoreEntry[], caller: RestoreEntry | undefined, tab: MeetingTab): number | undefined {
  const own = entries.filter((entry) => entry.team === tab.team && entry.session === tab.session);
  const tabs = tab.callerIsMet && caller !== undefined ? [...own, caller] : own;
  const stamps = tabs.flatMap((entry) => (entry.ownerPromptAt === undefined ? [] : [entry.ownerPromptAt]));
  return stamps.length === 0 ? undefined : Math.max(...stamps);
}

/**
 * The minutes since the owner's last prompt in the meeting's tab when `meeting end` must refuse: the caller's turn
 * was started by a prompt teamrig submitted and that prompt is under `ownerLeftMinutes` old. Undefined when it may
 * end the meeting.
 */
export function ownerStillInMinutes(caller: RestoreEntry | undefined, ownerPromptAt: number | undefined, now: number, ownerLeftMinutes: number): number | undefined {
  if (caller?.lastPromptByKit !== true || ownerPromptAt === undefined) {
    return undefined;
  }
  const quiet = now - ownerPromptAt;
  return quiet < ownerLeftMinutes * MS_PER_MINUTE ? Math.max(0, Math.floor(quiet / MS_PER_MINUTE)) : undefined;
}

/**
 * The minutes since the owner prompted in the meeting's tab when the turn of `claudeSession` (the caller's tab,
 * `$CLAUDE_CODE_SESSION_ID`) may not end the meeting; undefined when it may, or when the call runs in no tab.
 */
export async function ownerStillIn(files: Files, kitHome: string, claudeSession: string | undefined, tab: MeetingTab, now: number, ownerLeftMinutes: number): Promise<number | undefined> {
  if (ownerLeftMinutes === 0 || claudeSession === undefined || !CLAUDE_SESSION_ID.test(claudeSession)) {
    return undefined;
  }
  const registry = new RestoreRegistry(files, restoreSessionsDir(kitHome));
  const caller = await registry.read(claudeSession);
  if (caller?.lastPromptByKit !== true) {
    return undefined;
  }
  return ownerStillInMinutes(caller, ownerPromptAtOf(await registry.list(), caller, tab), now, ownerLeftMinutes);
}

/** What `meeting end` refuses with while the owner is still in the meeting, and how to end it anyway. */
export interface OwnerInFacts {
  /** The meeting, as the line names it: `meeting M3`, `the daily meeting`. */
  readonly what: string;
  /** Where the owner prompted: `this tab`, or the session met's tab. */
  readonly where: string;
  readonly minutes: number;
  /** When the meeting lapses by itself, on the team's clock. */
  readonly endsAt: string;
  /** The command that ends it anyway. */
  readonly anyway: string;
}

export function ownerInRefusal(facts: OwnerInFacts): string {
  return (
    `${facts.what} is still on: the owner prompted in ${facts.where} ${facts.minutes} min ago and this turn was started by ${KIT_NAME}; ` +
    `the owner ends it, or it ends itself ${facts.endsAt}; ${facts.anyway} ends it anyway`
  );
}
