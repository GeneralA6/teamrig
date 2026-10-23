import { parseTranscriptLine } from '../budget/line.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { RELOAD_COMMAND } from '../mod/reload-hand.ts';
import type { RestoreEntry } from './entry.ts';

/**
 * Tabs that run without teamrig's hooks, kept pure: a session's restore entry is its hooks' heartbeat (written at
 * each prompt and turn end, and every few minutes of a turn's tool calls), and the model's replies in its
 * transcript are the turns it runs. A reply long after the entry's last write is a turn run with its hooks off, as
 * after a plugin update a tab never reloaded: it gets no inbox, no guards and no tab status. A transcript also
 * moves with no turn, and so with no hook: each /reload-plugins (the person's, or the reload hand's after every
 * plugin update), away summaries and Claude Code's own notes; only a reply counts (T1055). The check names each
 * such tab once (`hooklessNews`) to whoever can tell its person, and again only after it had its hooks back.
 */

/** The format of the check's state file this code reads and writes; a file in another format reads as no check yet. */
export const HOOKLESS_STATE_FORMAT = 1;

/**
 * How far a reply runs past its entry's last write before the tab reads as hookless: well past the few minutes
 * between a turn's heartbeats (`TOOL_END_WRITE_MS`), and past the longest single tool call, during which neither
 * moves.
 */
export const HOOKLESS_MS = 30 * MS_PER_MINUTE;

/** How often the Stop hooks check, across the team. */
export const HOOKLESS_CHECK_MS = 10 * MS_PER_MINUTE;

/**
 * How much of a transcript's end the check reads for its last reply: a working tab writes one every few lines, so
 * only a result line longer than this hides it, and the next check sees past it. Read only for a transcript that
 * moved lately, well past its last hook (`workedPastHook`).
 */
export const HOOKLESS_TAIL_BYTES = 256 * 1024;

/** The team's check: when it last ran, and the Claude Code sessions it already named. */
export interface HooklessState {
  readonly checkedAt: number;
  readonly told: readonly string[];
}

/** What the end of a tab's transcript says it did, in epoch ms; undefined where it holds none. */
export interface TabActivity {
  /** The main thread's last reply: a turn ran then. */
  readonly turnAt: number | undefined;
  /** The last /reload-plugins, typed by its person or run by the reload hand. */
  readonly reloadAt: number | undefined;
}

/** A team session's tab that runs turns while its hooks do not. */
export interface HooklessTab {
  readonly claudeSession: string;
  readonly session: string;
  /** The entry's last write: the session's last hook. */
  readonly hookAt: number;
  /** The main thread's last reply. */
  readonly turnAt: number;
  /** A /reload-plugins run after the last hook and before that reply, which so did not bring the hooks back. */
  readonly reloadAt?: number;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The state file's content; undefined when it is damaged or from another format, which reads as no check yet. */
export function parseHooklessState(text: string): HooklessState | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== HOOKLESS_STATE_FORMAT) {
    return undefined;
  }
  const { checkedAt, told } = record;
  if (!isTime(checkedAt) || !Array.isArray(told)) {
    return undefined;
  }
  const sessions = told.filter((id): id is string => typeof id === 'string');
  return sessions.length === told.length ? { checkedAt, told: sessions } : undefined;
}

export function formatHooklessState(state: HooklessState): string {
  return toJsonlLine({ [VERSION_FIELD]: HOOKLESS_STATE_FORMAT, checkedAt: state.checkedAt, told: [...state.told] });
}

/** Whether a hook checks now: `HOOKLESS_CHECK_MS` passed since the last check, or the clock went back past it. */
export function isCheckDue(state: HooklessState | undefined, now: number): boolean {
  return state === undefined || now < state.checkedAt || now - state.checkedAt >= HOOKLESS_CHECK_MS;
}

/**
 * The entries whose transcript the check reads: a live session of `team` (one of its `sessions` now, not ended,
 * with a transcript) whose hooks last wrote more than `HOOKLESS_MS` ago. A session off the team, as a retired
 * hire whose tab stayed open, is not the team's to tell (T1055). Only these cost a file's stat, and only those
 * whose file `workedPastHook` the end of the file.
 */
export function staleEntries(entries: readonly RestoreEntry[], team: string, sessions: readonly string[], now: number): RestoreEntry[] {
  return entries.filter(
    (entry) =>
      entry.team === team &&
      entry.session !== undefined &&
      sessions.includes(entry.session) &&
      entry.endedAt === undefined &&
      entry.transcriptPath !== undefined &&
      now - entry.updatedAt > HOOKLESS_MS,
  );
}

/**
 * Whether something the tab did at `at` reads as work without hooks: within the last `HOOKLESS_MS` (the session
 * works now) and more than `HOOKLESS_MS` after its hooks' last write at `hookAt`. Its file's last change passing
 * this is what makes the check read a transcript's end, since a reply is never later than the file's change.
 */
export function workedPastHook(hookAt: number, at: number, now: number): boolean {
  return now - at <= HOOKLESS_MS && at - hookAt > HOOKLESS_MS;
}

/**
 * The last reply and reload in a transcript's lines (`lines` holds whole lines only: a caller reading from inside
 * a file drops its first). A helper's reply (a sidechain) is left out: a helper's tool ends write the heartbeat,
 * but its replies can outlive its parent's turn.
 */
export function tabActivity(lines: readonly string[]): TabActivity {
  let turnAt: number | undefined;
  let reloadAt: number | undefined;
  for (const raw of lines) {
    const line = parseTranscriptLine(raw);
    if (line === undefined || line.at === undefined) {
      continue;
    }
    if (line.kind === 'call' && line.mainThread) {
      turnAt = Math.max(turnAt ?? line.at, line.at);
    } else if (line.kind === 'prompt' && line.commands.includes(RELOAD_COMMAND)) {
      reloadAt = Math.max(reloadAt ?? line.at, line.at);
    }
  }
  return { turnAt, reloadAt };
}

/**
 * The tabs that run without their hooks: a stale entry whose last reply `workedPastHook`. `activity` holds what
 * each stale entry's transcript end says, by Claude Code session; one it lacks (not read, no file) is skipped. A
 * /reload-plugins since that reply may have brought the hooks back, so the tab is not named until its next reply;
 * one between the last hook and that reply is kept, for the line to ask for more than another reload.
 */
export function hooklessTabs(stale: readonly RestoreEntry[], activity: ReadonlyMap<string, TabActivity>, now: number): HooklessTab[] {
  return stale.flatMap((entry) => {
    const found = activity.get(entry.claudeSession);
    const turnAt = found?.turnAt;
    const reloadAt = found?.reloadAt;
    if (entry.session === undefined || turnAt === undefined || !workedPastHook(entry.updatedAt, turnAt, now) || (reloadAt !== undefined && reloadAt >= turnAt)) {
      return [];
    }
    const reloaded = reloadAt !== undefined && reloadAt > entry.updatedAt;
    return [{ claudeSession: entry.claudeSession, session: entry.session, hookAt: entry.updatedAt, turnAt, ...(reloaded ? { reloadAt } : {}) }];
  });
}

/** The tabs a check names: hookless now and not named at the last check. */
export function hooklessNews(state: HooklessState | undefined, tabs: readonly HooklessTab[]): HooklessTab[] {
  const told = new Set(state?.told ?? []);
  return tabs.filter((tab) => !told.has(tab.claudeSession));
}

/** What a check writes: its time and the tabs hookless now, so a tab that had its hooks back is named again later. */
export function checkedState(now: number, tabs: readonly HooklessTab[]): HooklessState {
  return { checkedAt: now, told: tabs.map((tab) => tab.claudeSession) };
}

/**
 * Who hears of a hookless tab: the lead, or the coordinator's owner when the lead's own tab is hookless, since
 * the lead's inbox reminder is one of the hooks it lacks. With no coordinator's owner, the lead still.
 */
export function hooklessReader(tab: HooklessTab, lead: string, coordinatorOwner: string | undefined): string {
  return tab.session === lead && coordinatorOwner !== undefined ? coordinatorOwner : lead;
}

/**
 * The inbox line naming a hookless tab, its times as `clock` writes them (`14:20 IDT`). It asks for a reload, or,
 * when a reload already ran and the tab still works without hooks, never for another: it asks for a restart.
 */
export function hooklessLine(tab: HooklessTab, clock: (at: Date) => string): string {
  const minutes = Math.round((tab.turnAt - tab.hookAt) / MS_PER_MINUTE);
  const fix =
    tab.reloadAt === undefined
      ? 'type /reload-plugins in that tab'
      : `the /reload-plugins at ${clock(new Date(tab.reloadAt))} did not bring them back: /exit that tab and run claude --resume ${tab.claudeSession} in its folder`;
  return (
    `HOOKLESS ${tab.session}: its tab (Claude session ${tab.claudeSession.slice(0, 8)}) worked ${minutes} min past its last teamrig hook ` +
    `(hook ${clock(new Date(tab.hookAt))}, last reply ${clock(new Date(tab.turnAt))}), so it gets no inbox, guards or tab status: ${fix}`
  );
}
