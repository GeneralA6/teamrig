import { join } from 'node:path';
import { instantField, stringField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';
import { LOGIN_PROBE_STALE_MS } from './login.ts';

/**
 * The day-start probe: of the tabs due for a day-start or burst moment, the first wakes alone, and the others wait
 * until a reply shows the login works. A login that expired overnight then costs one failed turn, after which the
 * login marker (login.ts) holds the rest, not a dozen tabs stuck at once. The login is the account's, shared by every
 * team and tab of the kit home, so there is one probe per kit home. It has a file of its own, not a field in the login
 * marker: the marker exists only once a login has expired, while a probe goes out at every moment, the login working.
 */

/** The probe's file, beside the login marker. */
export function dayProbePath(kitHome: string): string {
  return join(kitHome, 'restore', 'day-probe.json');
}

/**
 * The format of the probe files this code writes. A file in any other format reads as no probe, and a write to one in
 * a newer format is refused; the file came with its format, so no file without one was ever written.
 */
export const DAY_PROBE_FORMAT = 1;

export interface DayProbe {
  /** The moment it tests the login for: the newest of the moments due for the tab that claimed it. */
  readonly moment: number;
  /** The tab (Claude session id) that claimed it and woke. */
  readonly tab: string;
  /** When that tab claimed it. */
  readonly at: number;
  /** The first reply after `at` that showed the login works; undefined while none has. */
  readonly releasedAt: number | undefined;
}

/**
 * Why a tab claims the probe: none was out, the one out was for an older moment, the tab's own claim is still out (its
 * wake did not turn), or the one out had no reply in time.
 */
export type DayProbeClaimWhy = 'first' | 'newer' | 'again' | 'stale';

/** What `gateDayProbe` says to a due tab: wake as the probe, wake (the login works), or wait for the probe until `until`. */
export type DayProbeGate =
  | { readonly kind: 'claim'; readonly why: DayProbeClaimWhy; readonly probe: DayProbe }
  | { readonly kind: 'free' }
  | { readonly kind: 'hold'; readonly until: number; readonly probe: DayProbe };

/**
 * The gate for `tab`, due for `moment` at `now`. A probe for this moment or a newer one decides: released, the tab
 * wakes; still out, it waits; out with no reply for LOGIN_PROBE_STALE_MS (a dropped prompt), the tab takes it over.
 * The probe tab itself asks again only when its wake did not turn (a woken tab settles its moment): a dropped prompt,
 * or a restart that took the wake, which leaves the moment due. It wakes again on its first claim, whose time stands,
 * so the others still take over at the stale line however often its wakes drop.
 */
export function gateDayProbe(existing: DayProbe | undefined, moment: number, tab: string, now: number): DayProbeGate {
  const claim = (why: DayProbeClaimWhy, probeMoment: number): DayProbeGate => ({ kind: 'claim', why, probe: { moment: probeMoment, tab, at: now, releasedAt: undefined } });
  if (existing === undefined) {
    return claim('first', moment);
  }
  if (existing.moment < moment) {
    return claim('newer', moment);
  }
  if (existing.releasedAt !== undefined) {
    return { kind: 'free' };
  }
  if (existing.tab === tab) {
    return { kind: 'claim', why: 'again', probe: existing };
  }
  const until = existing.at + LOGIN_PROBE_STALE_MS;
  return now >= until ? claim('stale', existing.moment) : { kind: 'hold', until, probe: existing };
}

/** A reply a tab's hook saw: a good turn end, or a tool end of the tab's own turn (a helper's is none). */
export interface DayProbeReply {
  readonly kind: 'answered' | 'tool';
  readonly tab: string;
  readonly at: number;
}

/**
 * The probe `reply` releases; undefined when it changes nothing. Any tab's good turn end after the claim shows the
 * login works, but a tool end only the probe tab's: another tab's tool may have run since before the claim, called by
 * a reply from before it. The probe tab was idle until its wake, so its first tool end comes at its first reply.
 */
export function releaseDayProbe(existing: DayProbe | undefined, reply: DayProbeReply): DayProbe | undefined {
  if (existing === undefined || existing.releasedAt !== undefined || reply.at <= existing.at) {
    return undefined;
  }
  return reply.kind === 'tool' && reply.tab !== existing.tab ? undefined : { ...existing, releasedAt: reply.at };
}

const CLAIM_WORDS: Readonly<Record<DayProbeClaimWhy, string>> = {
  first: 'the first tab due',
  newer: 'a newer moment than the last probe',
  again: 'its wake did not turn',
  stale: `the probe out had no reply in ${LOGIN_PROBE_STALE_MS / MS_PER_MINUTE} min`,
};

/** The restore log's line for a claim, without its time: which tab tests the login, for which moment, and why it. */
export function dayProbeClaimLine(tabLabel: string, why: DayProbeClaimWhy, probe: DayProbe): string {
  return `day-probe: claimed by ${tabLabel} for the moment at ${isoOf(probe.moment)}, ${CLAIM_WORDS[why]}`;
}

/** The restore log's line for a release, without its time: who showed the login works, and how long the others waited. */
export function dayProbeReleaseLine(tabLabel: string, reply: DayProbeReply, released: DayProbe): string {
  const how = reply.kind === 'answered' ? 'ended a turn' : 'ran a tool';
  return `day-probe: released, ${tabLabel} ${how} ${Math.round((reply.at - released.at) / 1000)} s after the claim`;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The probe's file text: times as ISO instants, indented JSON. */
export function formatDayProbe(probe: DayProbe): string {
  const record = {
    [VERSION_FIELD]: DAY_PROBE_FORMAT,
    moment: isoOf(probe.moment),
    tab: probe.tab,
    at: isoOf(probe.at),
    releasedAt: probe.releasedAt === undefined ? undefined : isoOf(probe.releasedAt),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The probe a file holds; undefined when it is damaged, of another shape or of another format, so the next due tab claims anew. */
export function parseDayProbe(text: string): DayProbe | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || recordVersion(record) !== DAY_PROBE_FORMAT) {
    return undefined;
  }
  const moment = instantField(record, 'moment');
  const tab = stringField(record, 'tab');
  const at = instantField(record, 'at');
  const releasedAt = instantField(record, 'releasedAt');
  if (moment === undefined || tab === undefined || !CLAUDE_SESSION_ID.test(tab) || at === undefined || (record['releasedAt'] !== undefined && releasedAt === undefined)) {
    return undefined;
  }
  return { moment, tab, at, releasedAt };
}
