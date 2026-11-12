import type { Files } from '../core/files.ts';
import { parseObject } from '../core/jsonl.ts';
import type { NeedKind, TabNeed } from './need.ts';

/**
 * Which tabs of the team ask the user something now, as another tab's needs-you band shows them (T2511): each tab file
 * (need.ts) that asks a kind `needsYou.kinds` names, the reader's own tab left out, newest first. During the owner's
 * open meeting only a p0 task's ask offers the Focus that moves the owner there; the rest wait for the meeting's end.
 */

/** A tab file that asks the user something: its kind and text are set. */
export interface AskingTab extends TabNeed {
  readonly kind: NeedKind;
  readonly text: string;
}

export function isAsking(need: TabNeed): need is AskingTab {
  return need.kind !== null && need.text !== null;
}

/** The priority whose ask breaks through the owner's open meeting: p0 alone. */
export const MEETING_BREAKTHROUGH_PRIORITY = 0;

/** The asks of tabs other than `own` (null: every tab), of a kind in `kinds`, newest first. */
export function asksFor(tabs: readonly TabNeed[], own: string | null, kinds: readonly NeedKind[]): AskingTab[] {
  const wanted = new Set<NeedKind>(kinds);
  return tabs
    .filter(isAsking)
    .filter((need) => need.session !== own && wanted.has(need.kind))
    .sort((left, right) => Date.parse(right.since) - Date.parse(left.since) || left.session.localeCompare(right.session));
}

/** Whether an ask offers its Focus: always outside a meeting; during one only for a task of the breakthrough priority. */
export function offersFocus(meetingOpen: boolean, priority: number | undefined): boolean {
  return !meetingOpen || priority === MEETING_BREAKTHROUGH_PRIORITY;
}

/** An ask's key: a tab's next ask rewrites its file with a new `since`, so the pair names one ask. */
function sentKey(need: Pick<TabNeed, 'since'>): string {
  return need.since;
}

/**
 * The asks the OS notification told of, `{ "<session>": "<since>" }`, one per asking tab, so one tab of the team sends
 * each. Rewritten whole under `needsYouLock` with only the tabs asking now, so it holds at most one line per session.
 */
export class NeedsYouSent {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  /**
   * The asks in `asking` not told of yet; records every ask in `asking` as told, and forgets tabs asking nothing now.
   * The caller holds the lock.
   */
  async markNew(asking: readonly AskingTab[]): Promise<AskingTab[]> {
    const sent = parseObject((await this.files.read(this.path)) ?? '') ?? {};
    const fresh = asking.filter((need) => sent[need.session] !== sentKey(need));
    const next = Object.fromEntries(asking.map((need) => [need.session, sentKey(need)]));
    if (fresh.length > 0 || Object.keys(sent).length !== asking.length) {
      await this.files.write(this.path, `${JSON.stringify(next)}\n`);
    }
    return fresh;
  }
}
