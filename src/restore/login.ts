import { join } from 'node:path';
import { instantField, isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { claudeConfigDir, type Env } from '../core/home.ts';
import { parseObject } from '../core/jsonl.ts';
import type { LockTimings } from '../core/lock.ts';
import { MS_PER_DAY, MS_PER_MINUTE } from '../core/time.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';

/**
 * The Claude login as the fleet saw it last: when it expired, which tabs a turn that ended on `Login expired` left
 * stuck, and which of them were retried since. The login is the account's, shared by every team and tab of the kit
 * home, so there is one marker per kit home. `hook restore-track` writes it on an auth failure and on the next good
 * turn end, and `hook wake-check` when a stuck tab claims its retry, each under a lock, since a day-start wake fails a
 * dozen tabs in the same second.
 */

/** The marker's file, beside the restore's sessions folder and log. */
export function loginMarkerPath(kitHome: string): string {
  return join(kitHome, 'restore', 'login.json');
}

/**
 * The file Claude Code keeps its login in, which /login and each token refresh rewrite: a change after the last
 * failure is the one sign that a new login may work before any turn proves it. It is only ever stat'ed, never read.
 * Where the login lives in the system's keychain (macOS) there is no file, so a stuck tab waits for another tab's good
 * turn instead.
 */
export function claudeCredentialsPath(env: Env, userHome: string): string {
  return join(claudeConfigDir(env, userHome), '.credentials.json');
}

/** The least time between two retries across the kit home, so a dozen stuck tabs come back one by one, not at once. */
export const LOGIN_RETRY_GAP_MS = 30_000;

/** How long the one retry that tests a new login holds the others back with no result: a dropped prompt frees it. */
export const LOGIN_PROBE_STALE_MS = 5 * MS_PER_MINUTE;

/** The marker's lock: held only for a read and a write of one small file, so a waiter gives up after a few seconds. */
export const LOGIN_LOCK: LockTimings = { ttlMs: 10_000, pollMs: 25, waitMs: 5_000 };

/** How long a tab stays stranded with no good turn: one closed meanwhile, or never retried, leaves the marker. */
export const STRANDED_KEEP_MS = 2 * MS_PER_DAY;

/** How much of a transcript's end is read for the error record of a turn that failed: it is the turn's last record. */
export const LOGIN_TAIL_BYTES = 64 * 1024;

/** The error Claude Code names an expired or revoked login by, in a StopFailure payload and its transcript record. */
export const AUTH_FAILED = 'authentication_failed';

export interface LoginMarker {
  /** The first auth failure of the latest expiry. */
  readonly expiredAt: number;
  /** The latest auth failure. */
  readonly lastFailAt: number;
  /** The first good turn end after `lastFailAt`; undefined while the login is still expired. */
  readonly recoveredAt: number | undefined;
  /** Each tab (Claude session id) whose last turn ended on an auth failure, and when. */
  readonly stranded: ReadonlyMap<string, number>;
  /** When a tab claimed the owner's page for the latest expiry; undefined while none has, so the next failure pages. */
  readonly pagedAt: number | undefined;
  /** The one retry sent to test a login renewed while it was expired: its tab and when; undefined when none is out. */
  readonly probe: LoginProbe | undefined;
  /** The latest retry any stuck tab claimed, which spaces the next one; undefined before the first. */
  readonly lastRetryAt: number | undefined;
  /** Each stuck tab's latest retry, so a tab retries once per sign the login works; only stuck tabs are kept. */
  readonly retried: ReadonlyMap<string, number>;
}

/** The retry that tests a renewed login: the stuck tab (Claude session id) that claimed it, and when. */
export interface LoginProbe {
  readonly tab: string;
  readonly at: number;
}

/** A turn end the marker follows: one that failed on the login, or one the model answered. */
export interface LoginEvent {
  readonly kind: 'auth-failed' | 'answered';
  readonly claudeSession: string;
  readonly at: number;
}

/** What a change says for the restore log: a new expiry, one more tab stuck in it, or the login working again. */
export type LoginNote = 'expired' | 'stranded' | 'recovered';

export type LoginChange = { readonly kind: 'write'; readonly marker: LoginMarker; readonly note: LoginNote | undefined } | { readonly kind: 'none' };

/** Why a stuck tab retries: a good turn proved the login (`recovered`), or it tests a renewed one (`probe`). */
export type LoginRetryWhy = 'recovered' | 'probe';

/**
 * What `decideLoginRetry` says of a tab: nothing to do (`none`: not stuck), stuck with nothing new that says the login
 * works (`stuck`: the next sign is a change of the marker or the credentials file), a retry due at `at`, or a retry
 * now with the marker claiming it.
 */
export type LoginRetry =
  | { readonly kind: 'none' }
  | { readonly kind: 'stuck' }
  | { readonly kind: 'later'; readonly at: number }
  | { readonly kind: 'retry'; readonly why: LoginRetryWhy; readonly failAt: number; readonly marker: LoginMarker };

/** True while the marker's latest expiry has no good turn after it. */
export function loginExpired(marker: LoginMarker): boolean {
  return marker.recoveredAt === undefined;
}

/**
 * Whether a StopFailure ended its turn on the login. The payload's `error` decides it; only a payload with none reads
 * the transcript's end (`tailOf`, undefined when there is none), whose last assistant record is the turn's synthetic
 * error message.
 */
export async function authFailureOf(payload: JsonRecord, tailOf: () => Promise<string | undefined>): Promise<boolean> {
  const error = stringField(payload, 'error');
  if (error !== undefined) {
    return error === AUTH_FAILED;
  }
  const tail = await tailOf();
  return tail !== undefined && lastAssistantFailedAuth(tail);
}

/** True when the last assistant record of `text` is an API error message for an auth failure; a torn first line is skipped. */
function lastAssistantFailedAuth(text: string): boolean {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const record = line.includes('"assistant"') ? parseObject(line) : undefined;
    if (record?.['type'] === 'assistant') {
      return record['isApiErrorMessage'] === true && record['error'] === AUTH_FAILED;
    }
  }
  return false;
}

/** The tabs still stranded at `at`: one stuck longer than `STRANDED_KEEP_MS` is dropped. */
function keptStranded(stranded: ReadonlyMap<string, number>, at: number): Map<string, number> {
  return new Map([...stranded].filter(([, failAt]) => at - failAt <= STRANDED_KEEP_MS));
}

function sameStranded(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  return left.size === right.size && [...left].every(([tab, at]) => right.get(tab) === at);
}

/** `stranded` with `tab` failed at `at`, keeping a later failure already there. */
function withStranded(stranded: ReadonlyMap<string, number>, tab: string, at: number): Map<string, number> {
  const next = new Map(stranded);
  next.set(tab, Math.max(at, stranded.get(tab) ?? at));
  return next;
}

/** The retries of the tabs still stuck: a tab freed or forgotten needs no record of its retry. */
function retriedOf(retried: ReadonlyMap<string, number>, stranded: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...retried].filter(([tab]) => stranded.has(tab)));
}

function authFailed(existing: LoginMarker | undefined, tab: string, at: number): LoginChange {
  const stranded = withStranded(keptStranded(existing?.stranded ?? new Map(), at), tab, at);
  const retried = retriedOf(existing?.retried ?? new Map(), stranded);
  // A failure after the recovery, or the first one ever, starts a new expiry. The retry spacing and each tab's
  // latest retry carry over: a retry is due again only at a newer sign the login works.
  if (existing === undefined || (existing.recoveredAt !== undefined && at > existing.recoveredAt)) {
    const marker: LoginMarker = { expiredAt: at, lastFailAt: at, recoveredAt: undefined, stranded, pagedAt: undefined, probe: undefined, lastRetryAt: existing?.lastRetryAt, retried };
    return { kind: 'write', marker, note: 'expired' };
  }
  // A failure the hooks report after a later recovery (out of order) belongs to the expiry that ended: it only strands its tab.
  if (existing.recoveredAt !== undefined) {
    return { kind: 'write', marker: { ...existing, lastFailAt: Math.max(existing.lastFailAt, at), stranded, retried }, note: 'stranded' };
  }
  const marker: LoginMarker = { ...existing, expiredAt: Math.min(existing.expiredAt, at), lastFailAt: Math.max(existing.lastFailAt, at), stranded, retried };
  return { kind: 'write', marker, note: 'stranded' };
}

/**
 * A good turn end proves the login works when it comes after the latest failure: its model answer needed the
 * login. A tool's end does not (its request may predate the expiry), nor a start (it calls no API). It frees its own
 * tab only from a failure before it.
 */
function answered(existing: LoginMarker | undefined, tab: string, at: number): LoginChange {
  if (existing === undefined) {
    return { kind: 'none' };
  }
  const stranded = keptStranded(existing.stranded, at);
  const failAt = stranded.get(tab);
  if (failAt !== undefined && failAt < at) {
    stranded.delete(tab);
  }
  const recovers = loginExpired(existing) && at > existing.lastFailAt;
  if (!recovers && sameStranded(stranded, existing.stranded)) {
    return { kind: 'none' };
  }
  // A recovery ends the probe's test: the stuck tabs now retry one by one (`decideLoginRetry`).
  const recovered = recovers ? { recoveredAt: at, probe: undefined } : {};
  const marker: LoginMarker = { ...existing, ...recovered, stranded, retried: retriedOf(existing.retried, stranded) };
  return { kind: 'write', marker, note: recovers ? 'recovered' : undefined };
}

/** How a turn end changes the marker (`existing`, undefined when there is none yet). */
export function applyLoginEvent(existing: LoginMarker | undefined, event: LoginEvent): LoginChange {
  return event.kind === 'auth-failed' ? authFailed(existing, event.claudeSession, event.at) : answered(existing, event.claudeSession, event.at);
}

/**
 * The marker with the owner's page claimed at `at`: only while the login is still expired and no tab has claimed the
 * page of this expiry, so a dozen tabs failing at once page once. Undefined when there is nothing to claim.
 */
export function claimPage(marker: LoginMarker, at: number): LoginMarker | undefined {
  return loginExpired(marker) && marker.pagedAt === undefined ? { ...marker, pagedAt: at } : undefined;
}

/**
 * The marker with a failed page's claim (`claimedAt`) given back, so the next failure pages again. Undefined when the
 * claim is no longer that one: a new expiry, or another tab's claim since.
 */
export function releasePage(marker: LoginMarker, claimedAt: number): LoginMarker | undefined {
  return marker.pagedAt === claimedAt ? { ...marker, pagedAt: undefined } : undefined;
}

/**
 * Whether a stuck tab's last turn should be sent again: `none` (not stuck), `stuck` (nothing new says the login works),
 * `later` (at `at`, when the retry spacing or another tab's open probe allows), or `retry`, with the marker that
 * claims it. `why` is `recovered` once a good turn after the last failure proved the login, and the tabs then retry
 * one per `LOGIN_RETRY_GAP_MS`; it is `probe` while the login is still expired but its credentials file changed after
 * the last failure (`credentialsAt`: a /login, or a refresh that worked), and only one tab tests it. A probe that fails
 * moves the last failure past the change, so nothing retries until the credentials change again; one with no result
 * after `LOGIN_PROBE_STALE_MS` frees the slot. A tab retries at most once per sign.
 */
export function decideLoginRetry(marker: LoginMarker | undefined, tab: string, now: number, credentialsAt: number | undefined): LoginRetry {
  const failAt = marker?.stranded.get(tab);
  if (marker === undefined || failAt === undefined) {
    return { kind: 'none' };
  }
  const retriedAt = marker.retried.get(tab);
  const claimed = (probe: LoginProbe | undefined): LoginMarker => ({ ...marker, probe, lastRetryAt: now, retried: new Map([...marker.retried, [tab, now]]) });
  // A recovery covers every stuck tab: a failure after it would have started a new expiry.
  if (marker.recoveredAt !== undefined) {
    if (retriedAt !== undefined && retriedAt >= marker.recoveredAt) {
      return { kind: 'stuck' };
    }
    const spacedUntil = marker.lastRetryAt === undefined ? undefined : marker.lastRetryAt + LOGIN_RETRY_GAP_MS;
    return spacedUntil !== undefined && now < spacedUntil ? { kind: 'later', at: spacedUntil } : { kind: 'retry', why: 'recovered', failAt, marker: claimed(undefined) };
  }
  if (credentialsAt === undefined || credentialsAt <= marker.lastFailAt || (retriedAt !== undefined && retriedAt >= credentialsAt)) {
    return { kind: 'stuck' };
  }
  const { probe } = marker;
  if (probe !== undefined && probe.at > marker.lastFailAt && now < probe.at + LOGIN_PROBE_STALE_MS) {
    return { kind: 'later', at: probe.at + LOGIN_PROBE_STALE_MS };
  }
  return { kind: 'retry', why: 'probe', failAt, marker: claimed({ tab, at: now }) };
}

/**
 * Whether the day's start should hold its wakes: while the login is expired and nothing since the last failure says
 * it may work again. Once the credentials changed, the day's first tab tests the login and the rest wait for it.
 */
export function loginHoldsDayStart(marker: LoginMarker | undefined, credentialsAt: number | undefined): boolean {
  return marker !== undefined && loginExpired(marker) && !(credentialsAt !== undefined && credentialsAt > marker.lastFailAt);
}

/** The owner's page for an expiry: `tab` names the tab whose failure claimed it, `clock` the failure's time on the team's clock. */
export function loginPageText(tab: string, clock: string): string {
  return `Claude login expired: ${tab} ended its turn on Login expired at ${clock}. Run /login in any tab, then prompt the tabs that stopped.`;
}

/** The restore log's line for a change's note: `tab` names the tab whose turn end made it. */
export function loginLogLine(note: LoginNote, tab: string, marker: LoginMarker): string {
  const stuck = `${marker.stranded.size} tab(s) stuck`;
  switch (note) {
    case 'expired':
      return `login: expired, ${tab} ended its turn on Login expired; ${stuck}`;
    case 'stranded':
      return `login: ${tab} ended its turn on Login expired; ${stuck}`;
    case 'recovered':
      return `login: works again, ${tab} answered; ${stuck}`;
  }
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The marker's file text: times as ISO instants, indented JSON. */
export function formatLoginMarker(marker: LoginMarker): string {
  const record = {
    expiredAt: isoOf(marker.expiredAt),
    lastFailAt: isoOf(marker.lastFailAt),
    recoveredAt: marker.recoveredAt === undefined ? undefined : isoOf(marker.recoveredAt),
    stranded: instantsRecord(marker.stranded),
    pagedAt: marker.pagedAt === undefined ? undefined : isoOf(marker.pagedAt),
    probe: marker.probe === undefined ? undefined : { tab: marker.probe.tab, at: isoOf(marker.probe.at) },
    lastRetryAt: marker.lastRetryAt === undefined ? undefined : isoOf(marker.lastRetryAt),
    retried: instantsRecord(marker.retried),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** A map of tabs to instants as the file keeps it: each Claude session id to an ISO instant. */
function instantsRecord(byTab: ReadonlyMap<string, number>): Record<string, string> {
  return Object.fromEntries([...byTab].map(([tab, at]) => [tab, isoOf(at)]));
}

/** A map of tabs to instants (the stuck tabs, their retries); undefined when a key is not a Claude session id or a time not an instant. */
function instantsByTabOf(value: unknown): Map<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const byTab = new Map<string, number>();
  for (const tab of Object.keys(value)) {
    const at = instantField(value, tab);
    if (!CLAUDE_SESSION_ID.test(tab) || at === undefined) {
      return undefined;
    }
    byTab.set(tab, at);
  }
  return byTab;
}

/** The probe a file holds; undefined when its tab is not a Claude session id or its time not an instant. */
function probeOf(value: unknown): LoginProbe | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tab = stringField(value, 'tab');
  const at = instantField(value, 'at');
  return tab === undefined || !CLAUDE_SESSION_ID.test(tab) || at === undefined ? undefined : { tab, at };
}

/** True when an optional field is in the record but does not read as its value. */
function damagedOptional(record: JsonRecord, key: string, value: unknown): boolean {
  return record[key] !== undefined && value === undefined;
}

/**
 * The marker a file holds; undefined when it is damaged or of another shape, which the next auth failure replaces. A
 * marker written before the retries (no `probe`, `lastRetryAt` or `retried`) reads as one with none.
 */
export function parseLoginMarker(text: string): LoginMarker | undefined {
  const record = parseObject(text.trim());
  if (record === undefined) {
    return undefined;
  }
  const expiredAt = instantField(record, 'expiredAt');
  const lastFailAt = instantField(record, 'lastFailAt');
  const recoveredAt = instantField(record, 'recoveredAt');
  const pagedAt = instantField(record, 'pagedAt');
  const stranded = instantsByTabOf(record['stranded']);
  const probe = probeOf(record['probe']);
  const lastRetryAt = instantField(record, 'lastRetryAt');
  const retried = record['retried'] === undefined ? new Map<string, number>() : instantsByTabOf(record['retried']);
  const optionals: readonly (readonly [string, unknown])[] = [
    ['recoveredAt', recoveredAt],
    ['pagedAt', pagedAt],
    ['probe', probe],
    ['lastRetryAt', lastRetryAt],
  ];
  if (expiredAt === undefined || lastFailAt === undefined || stranded === undefined || retried === undefined || optionals.some(([key, value]) => damagedOptional(record, key, value))) {
    return undefined;
  }
  return { expiredAt, lastFailAt, recoveredAt, stranded, pagedAt, probe, lastRetryAt, retried };
}
