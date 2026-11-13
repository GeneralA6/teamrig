import { join } from 'node:path';
import { isNonNegativeInteger, isRecord } from '../core/guards.ts';
import type { Files } from '../core/files.ts';
import { ENV, type Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import type { TimeZone } from '../core/zone.ts';
import { AdmitFile } from './admit-file.ts';
import { admissionOrder, classOf, placeInLine, type AdmissionRules } from './admission.ts';
import type { CpuGate } from './cpu.ts';
import { charge, DEFAULT_EXPECTED_MINUTES, EMPTY_TURNS, endedAtOf, endedText, isNewerTurns, parseTurns, settle, turnsFor, turnsText, type OpenCharge, type TurnsState } from './class-turns.ts';
import { shortText, type CommitShort, type MemoryGate, type MemoryLook, type MemoryShort } from './memory-gate.ts';
import { isLineRequest, type LineRequest } from './process-request.ts';
import { causeOfLockWait, WAIT_CAUSES, type WaitCause } from './wait-log.ts';

/**
 * The host lock's file. Its fields are the ones a team's own deploy tool writes too, so both take the same
 * lock while a team moves its callers to teamrig; a field either adds is ignored.
 */
export interface HostLockInfo {
  /** Unique to one taking: only the step that took the lock releases it. Stored as `id` ({@link STORED_ID}). */
  readonly id: string;
  /** The process holding it; once that process is gone, the lock is stale. */
  readonly pid: number;
  readonly session: string;
  readonly purpose: string;
  /** The teamrig version that took it; an older teamrig or a team's own deploy tool leaves it out. */
  readonly kit?: string;
  /** An ISO time. */
  readonly acquiredAt: string;
  /** An ISO time; from it on, the lock is stale. */
  readonly expiresAt: string;
}

/**
 * Who holds the lock: a step, with `waitsFor` the steps still sharing the host (small or heavy), which it waits to end before its
 * own runs, when any are; or no one that can be named (a file still being written, or a damaged one).
 */
export type LockHolder = { readonly kind: 'held'; readonly info: HostLockInfo; readonly waitsFor?: readonly HostShare[] } | { readonly kind: 'unknown' };

/**
 * A step waiting for the lock, as its ticket in the line says: the file `<lock>.queue/<arrival ms>-<id>.json`, the
 * arrival in 15 digits so the folder's names sort in arrival order.
 */
export interface LockWaiter {
  readonly id: string;
  /** The waiting process; once it is gone, the ticket is stale. */
  readonly pid: number;
  readonly session: string;
  readonly purpose: string;
  /** The teamrig version that wrote the ticket; an older teamrig leaves it out. */
  readonly kit?: string;
  /** An ISO time: when it joined the line. */
  readonly arrivedAt: string;
  /** An ISO time: when its wait runs out, plus `TICKET_GRACE_MS` for its last look; from it on, the ticket is stale. */
  readonly expiresAt: string;
  /**
   * True when its step stops once its ticket is withdrawn (`withdraw`); a step of an older kit never looks for its
   * ticket and runs anyway.
   */
  readonly stopsOnWithdraw?: boolean;
  /** What its step asks; left out by an older kit, and for a step that names no request. */
  readonly request?: TicketRequest;
  /** What it waited on at its last look; left out before its first look, and by an older kit. */
  readonly waitingOn?: WaitingOn;
}

/**
 * What a ticket or a share says its step asks, for admission to order the line by (T2210): its line request, the MB
 * held for it while it runs (`needMb`), whether it is a heavy step (`heavy`: it holds the lock or a heavy share) or a
 * small one, and whether it takes the whole host (`exclusive`: the lock file, which waits for every share to end).
 */
export interface TicketRequest extends LineRequest {
  readonly needMb: number;
  readonly heavy: boolean;
  readonly exclusive: boolean;
}

/**
 * What a waiter waits on, as its ticket says for a reader of the line (`teamrig pipeline`): its cause, its report as
 * the waiting step hears it (`waitText`), and since when (an ISO time) it has waited on that cause without a break.
 * The waiter writes it again only when its report changes (a new holder, a new place in line), so the numbers of a
 * wait on memory are the ones it first saw.
 */
export interface WaitingOn {
  readonly reason: WaitCause;
  readonly text: string;
  readonly since: string;
}

/** A ticket in the line: its file name and what it says. */
interface Ticket {
  readonly name: string;
  readonly waiter: LockWaiter;
}

/** This step's own ticket, `waiter` what its last write says. */
interface OwnTicket {
  readonly name: string;
  waiter: LockWaiter;
}

/** A waiter's place in the line in admission order: the waiters ahead that it may not pass, and its session's cap when reached. */
interface LinePlace {
  readonly ahead: readonly LockWaiter[];
  readonly capped?: SessionCapWait;
}

/**
 * The class turns as one look found them: the turns file's text (undefined when there is none), its state once the
 * steps' ends were read, and the names of the ended markers read.
 */
interface TurnsLook {
  readonly text: string | undefined;
  readonly state: TurnsState;
  readonly markers: readonly string[];
}

/** A waiter's place in the admission order, with the class turns it was ordered by and the classes with a step in line, its own among them. */
interface AdmissionView {
  readonly place: LinePlace;
  readonly turns: TurnsLook;
  readonly waiting: ReadonlySet<string>;
}

/** How a step holds the host: a small share, a heavy share at most `cap` heavy shares at once, or the whole host (the lock file). */
type Hold = { readonly kind: 'small' } | { readonly kind: 'heavy'; readonly cap: number } | { readonly kind: 'whole' };

/** One look in line: the waiters ahead that this step may not pass, and what it found. */
interface LineLook {
  readonly ahead: readonly LockWaiter[];
  readonly look: Look;
}

/**
 * A step sharing the host: a lock's fields under its own id, in the file `<lock>.shared/<id>.json`, with the memory
 * held for it while it runs. A small step (`teamrig queue --small`), or in admission's `pipeline` mode a heavy one
 * (`heavy`), while fewer than `maxHeavyParallel` heavy steps share it (T2210).
 */
export interface HostShare extends HostLockInfo {
  /** The MB held for it: another step is let in only while the host has this free besides. Kept beside `request.needMb`, as an older kit reads this one. */
  readonly reserveMb: number;
  /** True on a heavy step's share; left out on a small step's, and by an older kit, whose shares are all small. */
  readonly heavy?: boolean;
  /** What its step asked, copied from its ticket; left out by an older kit, and for a step that named no request. */
  readonly request?: TicketRequest;
}

/**
 * What a step asks of the host: to share it as a small step (`teamrig queue --small`) or to take the lock, and the MB
 * held for it while it runs. A step that asks nothing takes the lock with the gate's `heavyReserveMb` held for it.
 */
export interface StepNeed {
  readonly shares: boolean;
  readonly reserveMb: number;
  /** Where `reserveMb` came from, which a wait on memory names (`learned from 12 runs`); unset for a default. */
  readonly basis?: string;
  /** The minutes the step is expected to run: the median of the past runs its need was learned from; unset when none was. */
  readonly expectedMinutes?: number;
}

/**
 * What a step in line asks of the host: how it holds it (`need`; none is a heavy step, with the gate's
 * `heavyReserveMb` held for it), whether it takes the whole host (`exclusive`: the lock file, in `pipeline` mode too,
 * as a merge or a deploy does; it wins over a small need), and what it works for (`request`), which its ticket and
 * share carry.
 */
export interface StepAsk {
  readonly need?: StepNeed;
  readonly exclusive?: boolean;
  readonly request?: LineRequest;
}

/**
 * How a share was let in: the host's free memory then (when the lock has a memory gate), the steps already sharing it,
 * and whether it is a heavy step's share.
 */
export interface Sharing {
  readonly freeMb?: number;
  readonly others: readonly HostShare[];
  readonly heavy: boolean;
}

/** The host's memory too short for a step, with the steps sharing the host (small or heavy) whose held MB counted as taken. */
export type MemoryWait = (MemoryShort | CommitShort) & { readonly shares: readonly HostShare[] };

/** A waiter's own session already running its cap of steps (`perSessionRunning`): `running`, the lock's holder and the shares it runs. */
export interface SessionCapWait {
  readonly kind: 'sessionCap';
  readonly cap: number;
  readonly running: readonly HostLockInfo[];
}

/** A heavy step first in line while `maxHeavyParallel` heavy steps already share the host (`cap`): `running`, those shares. */
export interface HeavyCapWait {
  readonly kind: 'heavyCap';
  readonly cap: number;
  readonly running: readonly HostShare[];
}

/**
 * A heavy step first in line, below the heavy cap, while the host's CPU is too busy for it beside the heavy steps
 * already sharing it (`running`, T2700): `idlePct` of its CPU time was idle, `needPct` needed
 * (`delivery.queue.heavyIdleCpuPct`).
 */
export interface CpuWait {
  readonly kind: 'cpu';
  readonly idlePct: number;
  readonly needPct: number;
  readonly running: readonly HostShare[];
}

/**
 * What a waiter waits on: the lock's holder, the earlier waiter the free lock goes to next, the steps sharing the host
 * that a step that took the lock waits to end, or, for the first in line, the host's free memory or commit charge
 * (`MemoryWait`). In admission's `pipeline` mode also its session's cap (`sessionCap`), the heavy steps sharing the
 * host at their cap (`heavyCap`) or with the CPU too busy for one more (`cpu`), and, for a moment, another step being
 * admitted (`admitting`), which holds the admit file.
 */
export type LockWait =
  | LockHolder
  | { readonly kind: 'queued'; readonly first: LockWaiter }
  | { readonly kind: 'draining'; readonly shares: readonly HostShare[] }
  | MemoryWait
  | SessionCapWait
  | HeavyCapWait
  | CpuWait
  | { readonly kind: 'admitting' };

/**
 * A lock taken, `sharing` set when it is a share of the host (a small step's, or a heavy one's); what the step still waits on; or its ticket
 * withdrawn from the line, so the step must not run.
 */
export type Taking =
  | { readonly kind: 'taken'; readonly lock: HostLockInfo; readonly sharing?: Sharing }
  | { readonly kind: 'busy'; readonly holder: LockWait }
  | { readonly kind: 'withdrawn' };

/** One look at the lock: taken, or what the step still waits on; only a step in line learns it was withdrawn. */
export type Look = Exclude<Taking, { readonly kind: 'withdrawn' }>;

/**
 * What `withdraw` did with a waiting step's ticket: removed it, so the step stops at its next look and never runs; found
 * the step took its turn first and is `running` under the lock or a share, or has `left` the line (it ran, or its wait
 * ran out); or `kept` it, as an older kit's step runs anyway.
 */
export type Withdrawal = { readonly kind: 'withdrawn' | 'running' | 'left' | 'kept'; readonly waiter: LockWaiter };

/** Hears what a waiter waits on, with the number of waiters ahead of it. */
type Tell = (holder: LockWait, ahead: number) => void;

/** The lock as a reader sees it: free, held, stale (expired or its process gone; the next step removes it) or being written. */
export type LockState = { readonly kind: 'free' } | { readonly kind: 'stale'; readonly info: HostLockInfo } | LockHolder;

export interface HostLockPorts {
  readonly files: Files;
  readonly clock: Clock;
  readonly sleep: Sleep;
  /** This process: the lock names it as the holder. */
  readonly pid: number;
  /** Whether a process still runs. */
  alive(pid: number): boolean;
  /** A new unique id. */
  newId(): string;
  /** The team's clock, which a waiter's ticket says its report on (`waitingOn`). */
  readonly zone: TimeZone;
  /**
   * The gate every step passes on the host's memory before it takes the lock or a share; none for a lock that guards no
   * step, as the deploy freezes' writers share.
   */
  readonly memory?: MemoryGate;
  /**
   * The gate a heavy step passes on the host's CPU before it joins another heavy step sharing the host (T2700); none
   * lets it in on memory alone.
   */
  readonly cpu?: CpuGate;
  /**
   * How the line is ordered (T2210): absent or `serial`, in arrival order, with no admit file and no session cap;
   * `pipeline`, in admission order (see the class).
   */
  readonly admission?: AdmissionRules;
}

type Seen = { readonly kind: 'missing' } | { readonly kind: 'unknown'; readonly text: string } | { readonly kind: 'held'; readonly info: HostLockInfo };

/** Tries per taking: a stale lock removed may be retaken by another step first. */
const ATTEMPTS = 3;

/**
 * How often the first in line looks, at most: it alone may take the lock, so a lock its holder released waits no
 * longer than this for the next step.
 */
export const FIRST_IN_LINE_POLL_MS = 2_000;

/**
 * How long a ticket outlives its step's wait: the last look comes at the wait's end, and no other step may remove the
 * ticket meanwhile, so a step whose live ticket is gone knows it was withdrawn.
 */
export const TICKET_GRACE_MS = 10_000;

/** A ticket's `expiresAt` for a wait that runs out at `deadline`. */
function ticketExpiry(deadline: number): string {
  return new Date(deadline + TICKET_GRACE_MS).toISOString();
}

/** Digits of a ticket's arrival time in its name: enough for any millisecond time, so names sort as times do. */
const ARRIVAL_DIGITS = 15;

/** A ticket's name; a writer's temporary sibling (`<name>.<pid>.<n>.tmp`) does not match. */
const TICKET_NAME = /^\d{15}-[^/\\]+\.json$/;

/** A share's name, its id's; a writer's temporary sibling does not match. */
const SHARE_NAME = /^[^/\\]+\.json$/;

/** An ended marker's name, its step's id's, as a share's is. */
const MARKER_NAME = SHARE_NAME;

const MARKER_SUFFIX = '.json';

/** The id of the step an ended marker named `name` (one {@link MARKER_NAME} matches) is for. */
function markerId(name: string): string {
  return name.slice(0, -MARKER_SUFFIX.length);
}

function byAcquiredAt(a: HostLockInfo, b: HostLockInfo): number {
  return Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** A record's `kit`: a version, or left out by a writer that does not name one. */
function isKit(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * `value` without a `kit` that is not a version: a team's own deploy tool may write a field of that name for its own
 * use, and a field another writer adds is ignored, never a reason to read its lock as damaged and remove it.
 */
function withoutForeignKit(value: unknown): unknown {
  return isRecord(value) && !isKit(value['kit']) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'kit')) : value;
}

/**
 * The name a lock's, a share's and a ticket's id is stored under: `id` (T1544, T1561). It was `token`, and the secret
 * redactor reads a long quoted literal given to `token` as a secret, so a session that showed the lock filed a rotation
 * task. The name changed only once a team's own deploy tool read `id` too, since a reader that misses its id takes the
 * lock for damaged and removes it, and two steps would run at once.
 */
const STORED_ID = 'id';

/**
 * `value` with its id under `id` alone, whichever name its writer stored it under: `token` from an older teamrig or deploy
 * tool still holding a lock; `id` wins in a file holding both. No `token` stays, so a record read and written back (a
 * renewed ticket) stores its id once.
 */
function withId(value: unknown): unknown {
  if (!isRecord(value) || !('token' in value)) {
    return value;
  }
  const { token, ...rest } = value;
  return typeof rest['id'] === 'string' || typeof token !== 'string' ? rest : { id: token, ...rest };
}

/** `record` as its file holds it: its id under {@link STORED_ID}. */
function stored<T extends { readonly id: string }>(record: T): string {
  const { id, ...rest } = record;
  return JSON.stringify({ [STORED_ID]: id, ...rest });
}

function isHostLockInfo(value: unknown): value is HostLockInfo {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['pid'] === 'number' &&
    typeof value['session'] === 'string' &&
    typeof value['purpose'] === 'string' &&
    isKit(value['kit']) &&
    isTime(value['acquiredAt']) &&
    isTime(value['expiresAt'])
  );
}

function isLockWaiter(value: unknown): value is LockWaiter {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['pid'] === 'number' &&
    typeof value['session'] === 'string' &&
    typeof value['purpose'] === 'string' &&
    isKit(value['kit']) &&
    isTime(value['arrivedAt']) &&
    isTime(value['expiresAt']) &&
    (value['stopsOnWithdraw'] === undefined || typeof value['stopsOnWithdraw'] === 'boolean') &&
    (value['request'] === undefined || isTicketRequest(value['request'])) &&
    (value['waitingOn'] === undefined || isWaitingOn(value['waitingOn']))
  );
}

function isTicketRequest(value: unknown): value is TicketRequest {
  return isLineRequest(value) && isRecord(value) && isNonNegativeInteger(value['needMb']) && typeof value['heavy'] === 'boolean' && typeof value['exclusive'] === 'boolean';
}

function isWaitCause(value: unknown): value is WaitCause {
  return WAIT_CAUSES.some((cause) => cause === value);
}

function isWaitingOn(value: unknown): value is WaitingOn {
  return isRecord(value) && isWaitCause(value['reason']) && typeof value['text'] === 'string' && isTime(value['since']);
}

/**
 * `value` without its field `key` when `is` cannot read it (a cause or a kind a later kit added): a ticket or a share
 * read as damaged is removed, and its step would lose its place, or its held MB, for a field it does not hold the host by.
 */
function withoutUnreadable(value: unknown, key: string, is: (field: unknown) => boolean): unknown {
  return isRecord(value) && value[key] !== undefined && !is(value[key]) ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) : value;
}

/** A ticket's or a share's fields that {@link withoutUnreadable} drops: what a reader of the line or admission reads, never what holds the host. */
function tidyTicket(value: unknown): unknown {
  return withoutUnreadable(withoutUnreadable(value, 'waitingOn', isWaitingOn), 'request', isTicketRequest);
}

function isHostShare(value: unknown): value is HostShare {
  return (
    isHostLockInfo(value) &&
    isRecord(value) &&
    typeof value['reserveMb'] === 'number' &&
    Number.isSafeInteger(value['reserveMb']) &&
    value['reserveMb'] >= 0 &&
    (value['heavy'] === undefined || typeof value['heavy'] === 'boolean') &&
    (value['request'] === undefined || isTicketRequest(value['request']))
  );
}

/** The record `text` holds when `is` takes it, once read and passed through `tidy` (by default, as it is). */
function parseAs<T>(text: string, is: (value: unknown) => value is T, tidy: (value: unknown) => unknown = (value) => value): T | undefined {
  try {
    const value = tidy(withId(withoutForeignKit(JSON.parse(text))));
    return is(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseLock(text: string): HostLockInfo | undefined {
  return parseAs(text, isHostLockInfo);
}

function parseWaiter(text: string): LockWaiter | undefined {
  return parseAs(text, isLockWaiter, tidyTicket);
}

function parseShare(text: string): HostShare | undefined {
  return parseAs(text, isHostShare, tidyTicket);
}

/**
 * `env` for a process a step starts while it holds `lock`: a `teamrig queue` that process starts (a git hook's checks
 * under a commit or a push) runs at once under the same lock, since waiting for it would wait on its own parent.
 */
export function underLock(env: Env, lock: HostLockInfo): Env {
  return { ...env, [ENV.hostLock]: lock.id };
}

/**
 * What a waiter waits on as a session reads it: `<session> (<purpose>) since <minute on zone's clock>` for a holder,
 * then its teamrig when another one took the lock (see {@link kitText}), then the steps sharing the host it still waits
 * for (`, waiting for 1 small step: <session> (<purpose>) since <minute>`).
 */
export function holderText(holder: LockWait, zone: TimeZone): string {
  switch (holder.kind) {
    case 'held': {
      const waiting = holder.waitsFor === undefined ? '' : `, waiting for ${sharesText(holder.waitsFor, zone)}`;
      return `${holder.info.session} (${holder.info.purpose}) since ${zone.minute(new Date(holder.info.acquiredAt))}${kitText(holder.info.kit)}${waiting}`;
    }
    case 'queued':
      return `${holder.first.session} (${holder.first.purpose}), first in line since ${zone.minute(new Date(holder.first.arrivedAt))}`;
    case 'unknown':
      return 'a writer that has not finished writing';
    case 'draining':
      return sharesText(holder.shares, zone);
    case 'memory':
    case 'commit':
      return `${holder.shares.length === 0 ? '' : `${sharesText(holder.shares, zone)}; `}${shortText(holder, holder.shares.length)}`;
    case 'sessionCap':
      return `${stepsText(holder.running.length, '')} of its session running, its cap ${holder.cap}: ${heldText(holder.running, zone)}`;
    case 'heavyCap':
      return `${stepsText(holder.running.length, 'heavy ')} running, the cap ${holder.cap}: ${heldText(holder.running, zone)}`;
    case 'cpu':
      return `host CPU ${holder.idlePct}% idle, ${holder.needPct}% needed (delivery.queue.heavyIdleCpuPct) beside ${stepsText(holder.running.length, 'heavy ')}: ${heldText(holder.running, zone)}`;
    case 'admitting':
      return 'another step being admitted';
  }
}

/** `1 step`, `2 heavy steps`: `count` steps of `kind` (a word and a space, or nothing). */
function stepsText(count: number, kind: string): string {
  return `${count} ${kind}step${count === 1 ? '' : 's'}`;
}

/** Each of `steps` as a holder: `<session> (<purpose>) since <minute on zone's clock>`, joined. */
function heldText(steps: readonly HostLockInfo[], zone: TimeZone): string {
  return steps.map((info) => holderText({ kind: 'held', info }, zone)).join(', ');
}

/** Whether `share` is a heavy step's share; an older kit's shares are all small. */
export function isHeavyShare(share: HostShare): boolean {
  return share.heavy === true;
}

/**
 * Nothing for a holder this teamrig took the lock with, else which one did: a version, or none named by a teamrig
 * older than the `kit` field or a team's own deploy tool, which may take a free lock without joining the line.
 */
function kitText(kit: string | undefined): string {
  if (kit === KIT_VERSION) {
    return '';
  }
  return kit === undefined ? ', on an older teamrig or another deploy tool' : `, on teamrig ${kit}`;
}

/**
 * The steps sharing the host, the heavy ones first when any run: `2 small steps: <session> (<purpose>) since <minute
 * on zone's clock>, ...`, or `1 heavy step: ... and 2 small steps: ...`.
 */
export function sharesText(shares: readonly HostShare[], zone: TimeZone): string {
  const heavy = shares.filter(isHeavyShare);
  const small = shares.filter((share) => !isHeavyShare(share));
  const smallText = `${stepsText(small.length, 'small ')}: ${heldText(small, zone)}`;
  if (heavy.length === 0) {
    return smallText;
  }
  const heavyText = `${stepsText(heavy.length, 'heavy ')}: ${heldText(heavy, zone)}`;
  return small.length === 0 ? heavyText : `${heavyText} and ${smallText}`;
}

/** How many steps share the host, by kind, the heavy ones first when any run: `2 small steps`, `1 heavy step and 2 small steps`. */
export function sharesCount(shares: readonly HostShare[]): string {
  const heavy = shares.filter(isHeavyShare).length;
  const small = stepsText(shares.length - heavy, 'small ');
  if (heavy === 0) {
    return small;
  }
  return heavy === shares.length ? stepsText(heavy, 'heavy ') : `${stepsText(heavy, 'heavy ')} and ${small}`;
}

/** A waiter's report: what it waits on, then how many waiters are ahead of it in line when any are. */
export function waitText(holder: LockWait, ahead: number, zone: TimeZone): string {
  return ahead === 0 ? holderText(holder, zone) : `${holderText(holder, zone)}; ${ahead} ahead in line`;
}

/** Why a step was refused when its wait ran out: `host memory still short: …`, `session cap still reached: …` or `host lock still held by …`. */
export function busyText(holder: LockWait, zone: TimeZone): string {
  switch (holder.kind) {
    case 'memory':
    case 'commit':
      return `host memory still short: ${holderText(holder, zone)}`;
    case 'sessionCap':
      return `session cap still reached: ${holderText(holder, zone)}`;
    case 'heavyCap':
      return `heavy cap still reached: ${holderText(holder, zone)}`;
    case 'cpu':
      return `host CPU still busy: ${holderText(holder, zone)}`;
    case 'held':
    case 'unknown':
    case 'queued':
    case 'draining':
    case 'admitting':
      return `host lock still held by ${holderText(holder, zone)}`;
  }
}

/** The ids of `locks`, joined. */
function idsOf(locks: readonly HostLockInfo[]): string {
  return locks.map((lock) => lock.id).join(',');
}

/** Tells one report apart from the last: a new holder, a step its holder waits for ending, or a new place in line. */
function waitKey(holder: LockWait, ahead: number): string {
  switch (holder.kind) {
    case 'held':
      return `held ${holder.info.id} ${idsOf(holder.waitsFor ?? [])} ${ahead}`;
    case 'queued':
      return `queued ${holder.first.id} ${ahead}`;
    case 'unknown':
      return `unknown ${ahead}`;
    case 'draining':
    case 'memory':
    case 'commit':
      return `${holder.kind} ${idsOf(holder.shares)} ${ahead}`;
    case 'sessionCap':
    case 'heavyCap':
    case 'cpu':
      return `${holder.kind} ${idsOf(holder.running)} ${ahead}`;
    case 'admitting':
      return `admitting ${ahead}`;
  }
}

/**
 * One waiter's reports: `onWait` hears only a new holder or a new place in line, and each new report is what its
 * ticket says it waits on next (`WaitingOn`), its `since` kept while the cause stays the same.
 */
class WaitReports {
  private readonly onWait: Tell;
  private readonly zone: TimeZone;
  private told: string | undefined;
  private waitingOn: WaitingOn | undefined;

  constructor(onWait: Tell, zone: TimeZone) {
    this.onWait = onWait;
    this.zone = zone;
  }

  /** Takes in the report of one look at `now`: what the ticket waits on next when it is new (and `onWait` heard it), else undefined. */
  report(holder: LockWait, ahead: number, now: number): WaitingOn | undefined {
    const key = waitKey(holder, ahead);
    if (key === this.told) {
      return undefined;
    }
    this.told = key;
    this.onWait(holder, ahead);
    const reason = causeOfLockWait(holder);
    const since = this.waitingOn?.reason === reason ? this.waitingOn.since : new Date(now).toISOString();
    this.waitingOn = { reason, text: waitText(holder, ahead, this.zone), since };
    return this.waitingOn;
  }
}

/**
 * The ids of the steps a waiter stands behind at one look: the waiters ahead, the lock's holder and the steps it
 * waits for, the steps sharing the host, its own session's steps running at its cap, the heavy steps at their cap.
 */
function standingBehind(ahead: readonly LockWaiter[], holder: LockWait): Set<string> {
  const ids = new Set(ahead.map((waiter) => waiter.id));
  switch (holder.kind) {
    case 'held':
      ids.add(holder.info.id);
      for (const share of holder.waitsFor ?? []) {
        ids.add(share.id);
      }
      break;
    case 'queued':
      ids.add(holder.first.id);
      break;
    case 'draining':
    case 'memory':
    case 'commit':
      for (const share of holder.shares) {
        ids.add(share.id);
      }
      break;
    case 'sessionCap':
    case 'heavyCap':
    case 'cpu':
      for (const info of holder.running) {
        ids.add(info.id);
      }
      break;
    case 'unknown':
    case 'admitting':
      break;
  }
  return ids;
}

/**
 * When a wait runs out: `maxWaitMs` after its line last moved, so a step far back in a line that keeps moving waits on
 * while the oldest work goes first. The line moved when a step this one stood behind at its last look (a waiter ahead,
 * the lock's holder, a small step sharing the host) is gone at this one.
 */
class Patience {
  private readonly maxWaitMs: number;
  private movedAt: number;
  private behind: ReadonlySet<string> = new Set();

  constructor(start: number, maxWaitMs: number) {
    this.movedAt = start;
    this.maxWaitMs = maxWaitMs;
  }

  get deadline(): number {
    return this.movedAt + this.maxWaitMs;
  }

  /** Takes in one look at `now`, the steps this one stands behind then; true when the line moved since the last look. */
  look(behind: ReadonlySet<string>, now: number): boolean {
    const moved = [...this.behind].some((id) => !behind.has(id));
    this.behind = behind;
    if (moved) {
      this.movedAt = now;
    }
    return moved;
  }
}

/**
 * One lock for the host's queued steps (builds, test runs, database scripts), held across the whole step. A step
 * takes it by creating the file; the file appears whole or not at all. A lock is stale once it expires or its
 * process is gone, and the next step removes it. A file that cannot be read is removed only after a waiter has
 * seen it so for `UNREADABLE_GRACE_MS`, since a writer that creates it in two steps may not have finished.
 * Waiters take it in their turn: each joins a line of tickets in `<lock>.queue`, and only the first live one may
 * take the lock; a ticket whose process is gone or whose wait ran out is removed by the next waiter that sees it.
 * The line is in arrival order; with admission rules in `pipeline` mode it is in admission order (`admissionOrder`:
 * p0 first, then class turn, aged priority, arrival), and a waiter whose session already runs its cap of steps is
 * passed (`placeInLine`). As that order moves with the clock, a waiter that finds itself first looks again and takes
 * its turn under the admit file, `<lock>.admit` ({@link AdmitFile}), so two waiters never both take a turn as first.
 * A wait runs out only once the line has not moved for its whole length (see `Patience`), so a step far back in a line
 * that keeps moving is not refused; its ticket's expiry moves on with its wait each time the line moves.
 * A step that does not join the line (an older kit, a team's own deploy tool) may still take a free lock first.
 * A session may withdraw its waiting steps (`withdraw`): each one's ticket is removed, and a step whose ticket is gone
 * stops at its next look. A step that took its turn removes its own ticket to run, so of the two removals only one
 * succeeds, and a withdrawn step never runs.
 * Small steps (`teamrig queue --small`: a spec run, a lint) share the host instead: in its turn, while the lock is not
 * held, a small step writes its share, `<lock>.shared/<id>.json`, before it leaves the line, so the next in line
 * sees it. A step that takes the lock waits, holding it, for the shares to end, so none is let in meanwhile. A share
 * whose process is gone, that expired or that cannot be read is removed by the next step that looks. A step that does
 * not know shares (an older kit) takes a free lock while they run.
 * In admission's `pipeline` mode a heavy step shares the host too, its share marked `heavy`, while fewer than
 * `maxHeavyParallel` heavy shares run, else it waits in its place on them (`heavyCap`). An exclusive step (a merge, a
 * deploy) and every heavy step in `serial` mode take the lock file instead, which waits for every share to end.
 * With a memory gate in its ports, the first in line takes the lock or a share only once the gate finds the host's
 * memory has room for it, the MB held for the small steps sharing the host counted as taken; until then it waits in
 * its place, so a later step never passes a step waiting on memory, and a lone step is gated as much as one beside others.
 */
export class HostLock {
  static readonly UNREADABLE_GRACE_MS = 10_000;

  private readonly path: string;
  private readonly queue: string;
  private readonly shared: string;
  private readonly admit: AdmitFile;
  private readonly turns: string;
  private readonly ended: string;
  private readonly ttlMs: number;
  private readonly ports: HostLockPorts;

  constructor(path: string, ttlMs: number, ports: HostLockPorts) {
    this.path = path;
    this.queue = `${path}.queue`;
    this.shared = `${path}.shared`;
    this.admit = new AdmitFile(`${path}.admit`, ports);
    this.turns = `${path}.turns.json`;
    this.ended = `${path}.ended`;
    this.ttlMs = ttlMs;
    this.ports = ports;
  }

  /**
   * Takes the lock when it is free or stale, else names its holder. `removeUnknown`: an unreadable file is
   * removed and the lock taken, for a waiter that has seen it so long enough. It does not look at the line.
   */
  async tryTake(session: string, purpose: string, removeUnknown: boolean = false): Promise<Look> {
    return this.take(session, purpose, removeUnknown, undefined);
  }

  /** {@link tryTake}, the lock carrying `id` when given (a waiter's ticket id), else a new one each attempt. */
  private async take(session: string, purpose: string, removeUnknown: boolean, id: string | undefined): Promise<Look> {
    let mayRemoveUnknown = removeUnknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const lock = this.newLock(session, purpose, id ?? this.ports.newId());
      if (await this.ports.files.createExclusive(this.path, stored(lock))) {
        return { kind: 'taken', lock };
      }
      const seen = await this.read();
      if (seen.kind === 'unknown') {
        if (!mayRemoveUnknown) {
          return { kind: 'busy', holder: { kind: 'unknown' } };
        }
        mayRemoveUnknown = false;
        await this.removeAt(this.path, (text) => text === seen.text);
      } else if (seen.kind === 'held') {
        if (!this.isStale(seen.info)) {
          return { kind: 'busy', holder: await this.heldBy(seen.info) };
        }
        await this.removeAt(this.path, (text) => parseLock(text)?.id === seen.info.id);
      }
    }
    const last = await this.read();
    return { kind: 'busy', holder: last.kind === 'held' ? await this.heldBy(last.info) : { kind: 'unknown' } };
  }

  /**
   * The holder `info` names, with the small steps sharing the host, which a holder that names its teamrig waits to end
   * before its step runs (`drain`); one without a `kit` (an older teamrig or a team's own deploy tool) runs beside them.
   */
  private async heldBy(info: HostLockInfo): Promise<LockHolder> {
    if (info.kit === undefined) {
      return { kind: 'held', info };
    }
    const waitsFor = await this.shares();
    return waitsFor.length === 0 ? { kind: 'held', info } : { kind: 'held', info, waitsFor };
  }

  /**
   * Takes the lock in its turn: joins the line, then looks again every `pollMs` (the first in line every
   * `FIRST_IN_LINE_POLL_MS` at most) until its line has not moved for `maxWaitMs`, and leaves the line when done.
   * `onWait` hears each new holder or place in line once, with the number of waiters ahead, and the step's ticket says
   * it as its `waitingOn` from then on. A lock taken then waits,
   * held, for the steps sharing the host to end. With an `ask` whose need shares, a small step shares the host in its
   * turn instead (see the class), and so does a heavy step that is not `exclusive` in admission's `pipeline` mode, while
   * fewer than `maxHeavyParallel` heavy steps share it; its reserve is the MB the memory gate needs for it. Busy when the wait ran out;
   * withdrawn when its ticket was withdrawn before it took its turn. Once `stop` aborts, the wait rejects with its
   * reason before its next look, as `fetch` does, leaving the line and releasing a lock it held while the small steps
   * ended, so a step no one waits for any more never takes the lock.
   */
  async acquire(session: string, purpose: string, maxWaitMs: number, pollMs: number, onWait: Tell, ask: StepAsk = {}, stop?: AbortSignal): Promise<Taking> {
    const patience = new Patience(this.ports.clock.now(), maxWaitMs);
    const ticket = await this.joinLine(session, purpose, patience.deadline, this.ticketRequestOf(ask));
    const reports = new WaitReports(onWait, this.ports.zone);
    try {
      const waited = await this.waitInLine(ticket, patience, pollMs, reports, ask, stop);
      const result = waited.kind === 'taken' && waited.sharing === undefined ? await this.drain(waited.lock, ticket, patience, reports, stop) : waited;
      return result.kind === 'taken' ? await this.commit(result, ticket) : result;
    } finally {
      await this.ports.files.remove(join(this.queue, ticket.name));
    }
  }

  /**
   * Releases a lock or share this step took; false when it is no longer the holder (it expired and another step took
   * it). Its end is marked first while its class's charge is open ({@link markEnded}).
   */
  async release(lock: HostLockInfo): Promise<boolean> {
    await this.markEnded(lock.id);
    if (await this.removeAt(this.path, (text) => parseLock(text)?.id === lock.id)) {
      return true;
    }
    const share = await this.shareWith(lock.id);
    if (share === undefined) {
      return false;
    }
    await this.ports.files.remove(share.path);
    return true;
  }

  /**
   * Marks the end of the step that took `id` (`<lock>.ended/<id>.json`) while its class's charge in the turns file is
   * open, so the next admission corrects that charge to the minutes the step ran. It is written before the lock or share
   * goes ({@link turnsLook} says why); a step admitted with no charge (`serial`, or no request) marks nothing.
   */
  private async markEnded(id: string): Promise<void> {
    const { files, clock } = this.ports;
    const name = `${id}${MARKER_SUFFIX}`;
    if (!MARKER_NAME.test(name) || !parseTurns(await files.read(this.turns)).open.some(({ ticket }) => ticket === id)) {
      return;
    }
    await files.write(join(this.ended, name), endedText(new Date(clock.now()).toISOString()));
  }

  /** The lock or share while the taking with `id` holds it and it is not stale; undefined otherwise. Takes and removes nothing. */
  async heldWith(id: string): Promise<HostLockInfo | undefined> {
    const seen = await this.read();
    if (seen.kind === 'held' && seen.info.id === id) {
      return this.isStale(seen.info) ? undefined : seen.info;
    }
    const share = (await this.shareWith(id))?.share;
    return share === undefined || this.isStale(share) ? undefined : share;
  }

  /**
   * The live waiters in the order they are let in: arrival order (no admission rules, or `serial`), else admission order
   * (`pipeline`) by the class turns as they stand; takes, removes and writes nothing. A waiter whose session runs its
   * cap of steps keeps its place here, though later ones pass it while it waits ({@link placeInLine}).
   */
  async line(): Promise<LockWaiter[]> {
    const line = await this.tickets();
    const { admission } = this.ports;
    if (admission === undefined || admission.mode === 'serial') {
      return line.map(({ waiter }) => waiter);
    }
    const state = await this.state();
    const running = [...(state.kind === 'held' ? [state.info.id] : []), ...(await this.shares()).map(({ id }) => id)];
    const turns = await this.turnsLook(new Set(running));
    const waiting = new Set(line.map(({ waiter }) => classOf(waiter, admission)));
    return admissionOrder(line, this.ports.clock.now(), admission, turnsFor(turns.state, waiting)).map(({ waiter }) => waiter);
  }

  /**
   * Withdraws the waiting steps of `session` that `chosen` picks: removes each one's ticket, so the step stops at its
   * next look and never runs. A step that took its turn first is named running, or gone from the line; an older kit's
   * step is kept, its ticket left, as removing it would only cost the step its place.
   */
  async withdraw(session: string, chosen: (waiter: LockWaiter) => boolean): Promise<Withdrawal[]> {
    const done: Withdrawal[] = [];
    for (const { name, waiter } of await this.tickets()) {
      if (waiter.session !== session || !chosen(waiter)) {
        continue;
      }
      if (waiter.stopsOnWithdraw !== true) {
        done.push({ kind: 'kept', waiter });
      } else if (await this.removeTicket(name)) {
        done.push({ kind: 'withdrawn', waiter });
      } else {
        done.push({ kind: (await this.heldWith(waiter.id)) === undefined ? 'left' : 'running', waiter });
      }
    }
    return done;
  }

  /** The steps sharing the host (small, or heavy in `pipeline` mode), oldest first, a stale share left out; takes and removes nothing. */
  async shares(): Promise<HostShare[]> {
    return (await this.shareFiles()).flatMap(({ share }) => (share === undefined || this.isStale(share) ? [] : [share])).sort(byAcquiredAt);
  }

  /** The lock's state, taking and removing nothing, for a reader that only shows it. */
  async state(): Promise<LockState> {
    const seen = await this.read();
    switch (seen.kind) {
      case 'missing':
        return { kind: 'free' };
      case 'unknown':
        return { kind: 'unknown' };
      case 'held':
        return this.isStale(seen.info) ? { kind: 'stale', info: seen.info } : seen;
    }
  }

  /** Looks in line until this step takes the lock, or a share when `ask` holds one ({@link holdOf}), in its turn, or its wait runs out; rejects once `stop` aborts. */
  private async waitInLine(ticket: OwnTicket, patience: Patience, pollMs: number, reports: WaitReports, ask: StepAsk, stop: AbortSignal | undefined): Promise<Taking> {
    const { clock, sleep } = this.ports;
    let unknownSince: number | undefined;
    for (;;) {
      stop?.throwIfAborted();
      const removeUnknown = unknownSince !== undefined && clock.now() - unknownSince >= HostLock.UNREADABLE_GRACE_MS;
      const looked = await this.lookInLine(ticket, removeUnknown, ask);
      if (looked === undefined) {
        return { kind: 'withdrawn' };
      }
      const { ahead, look: result } = looked;
      if (result.kind === 'taken') {
        return result;
      }
      const { holder } = result;
      unknownSince = holder.kind === 'unknown' ? (unknownSince ?? clock.now()) : undefined;
      const waitingOn = reports.report(holder, ahead.length, clock.now());
      if (!(await this.waitOn(ticket, patience, standingBehind(ahead, holder), waitingOn))) {
        return { kind: 'withdrawn' };
      }
      const left = patience.deadline - clock.now();
      if (left <= 0) {
        return result;
      }
      await sleep(Math.min(ahead.length === 0 ? Math.min(pollMs, FIRST_IN_LINE_POLL_MS) : pollMs, left));
    }
  }

  /**
   * One look in line: in arrival order (no admission rules, or `serial`), or in admission order (`pipeline`), where a
   * step that finds itself first looks again under the admit file and takes its turn there, keeping the class turns
   * ({@link keepTurns}); while another step holds that file, it waits on it (`admitting`). Undefined once its ticket is
   * gone, withdrawn.
   */
  private async lookInLine(ticket: OwnTicket, removeUnknown: boolean, ask: StepAsk): Promise<LineLook | undefined> {
    const { admission } = this.ports;
    if (admission === undefined || admission.mode === 'serial') {
      const ahead = await this.waitersAhead(ticket.name);
      return ahead === undefined ? undefined : { ahead, look: await this.inTurn(ticket.waiter, ahead, removeUnknown, ask) };
    }
    const view = await this.placeOf(ticket, admission);
    if (view === undefined) {
      return undefined;
    }
    if (view.place.capped !== undefined || view.place.ahead.length > 0) {
      return this.lookFrom(view.place, ticket.waiter, removeUnknown, ask);
    }
    const claim = await this.admit.claim(ticket.waiter.id);
    if (claim === undefined) {
      return { ahead: [], look: { kind: 'busy', holder: { kind: 'admitting' } } };
    }
    try {
      const again = await this.placeOf(ticket, admission);
      if (again === undefined) {
        return undefined;
      }
      const looked = await this.lookFrom(again.place, ticket.waiter, removeUnknown, ask);
      await this.keepTurns(again, looked.look.kind === 'taken' ? this.openCharge(ticket.waiter, ask.need) : undefined);
      return looked;
    } finally {
      await this.admit.release(claim);
    }
  }

  /** One look from `place`: its session's cap when reached, else its turn behind the waiters ahead ({@link inTurn}). */
  private async lookFrom(place: LinePlace, waiter: LockWaiter, removeUnknown: boolean, ask: StepAsk): Promise<LineLook> {
    const look: Look = place.capped === undefined ? await this.inTurn(waiter, place.ahead, removeUnknown, ask) : { kind: 'busy', holder: place.capped };
    return { ahead: place.ahead, look };
  }

  /** One look in its turn behind the waiters `ahead`: the lock for a step that takes the whole host ({@link takeInTurn}), else a share of it ({@link shareInTurn}). */
  private async inTurn(waiter: LockWaiter, ahead: readonly LockWaiter[], removeUnknown: boolean, ask: StepAsk): Promise<Look> {
    const hold = this.holdOf(ask);
    return hold.kind === 'whole' ? this.takeInTurn(waiter, ahead, removeUnknown, ask.need) : this.shareInTurn(waiter, ahead, removeUnknown, ask.need, hold);
  }

  /**
   * How a step that asks `ask` holds the host: the whole of it (the lock file) when exclusive; a small share when its
   * need shares; a heavy share in admission's `pipeline` mode, at most `maxHeavyParallel` at once; else the whole host.
   */
  private holdOf(ask: StepAsk): Hold {
    const { admission } = this.ports;
    if (ask.exclusive === true) {
      return { kind: 'whole' };
    }
    if (ask.need?.shares === true) {
      return { kind: 'small' };
    }
    return admission?.mode === 'pipeline' ? { kind: 'heavy', cap: admission.maxHeavyParallel } : { kind: 'whole' };
  }

  /**
   * Where `ticket` stands in the line in admission order under `rules`, given the steps each session runs now (the
   * lock's live holder and the live shares) and the class turns with the steps' ends read; undefined once its ticket is
   * gone, withdrawn.
   */
  private async placeOf(ticket: OwnTicket, rules: AdmissionRules): Promise<AdmissionView | undefined> {
    const line = await this.liveLine(ticket);
    if (line === undefined) {
      return undefined;
    }
    const running = await this.running();
    const turns = await this.turnsLook(new Set(running.map(({ id }) => id)));
    const waiting = new Set(line.map(({ waiter }) => classOf(waiter, rules)));
    const counts = new Map<string, number>();
    for (const { session } of running) {
      counts.set(session, (counts.get(session) ?? 0) + 1);
    }
    const place = placeInLine(admissionOrder(line, this.ports.clock.now(), rules, turnsFor(turns.state, waiting)), ticket.name, counts, rules);
    if (place === undefined) {
      return undefined;
    }
    const ahead = place.ahead.map(({ waiter }) => waiter);
    if (place.kind === 'inLine') {
      return { place: { ahead }, turns, waiting };
    }
    const capped: SessionCapWait = { kind: 'sessionCap', cap: place.cap, running: running.filter(({ session }) => session === ticket.waiter.session) };
    return { place: { ahead, capped }, turns, waiting };
  }

  /**
   * The class turns as they stand, given the ids of the steps running now (`running`: the lock's live holder and the
   * live shares), which the caller reads BEFORE this reads the ended markers: a release writes its marker before it
   * removes its lock or share, so a step that ends meanwhile is seen running or ended, never neither, which would close
   * its charge as a dead step's and drop the correction to the minutes it ran.
   */
  private async turnsLook(running: ReadonlySet<string>): Promise<TurnsLook> {
    const { files } = this.ports;
    const text = await files.read(this.turns);
    const markers = (await files.list(this.ended)).filter((name) => MARKER_NAME.test(name));
    const ended = new Map<string, number>();
    for (const name of markers) {
      const endedAt = endedAtOf(await files.read(join(this.ended, name)));
      if (endedAt !== undefined) {
        ended.set(markerId(name), endedAt);
      }
    }
    return { text, state: settle(parseTurns(text), ended, running), markers };
  }

  /**
   * Keeps, under the admit file, the class turns this admission read (`view`): with the steps' ends settled, and with
   * `step`'s charge when a step was admitted. It writes the turns file when that changed it (a missing file with no
   * turns stays missing), then removes each ended marker it read that no open charge names. In that order: a step that
   * stops between the two leaves markers whose charges are closed, which the next admission removes, never counting an
   * end twice. A turns file a newer teamrig wrote is kept as it is, its markers too, for a teamrig that reads it.
   */
  private async keepTurns(view: AdmissionView, step: OpenCharge | undefined): Promise<void> {
    const { files } = this.ports;
    const { turns, waiting } = view;
    if (isNewerTurns(turns.text)) {
      return;
    }
    const next = step === undefined ? turns.state : charge(turns.state, step, waiting);
    const text = turnsText(next);
    if (text !== (turns.text ?? turnsText(EMPTY_TURNS))) {
      await files.write(this.turns, text);
    }
    const open = new Set(next.open.map(({ ticket }) => ticket));
    for (const name of turns.markers.filter((marker) => !open.has(markerId(marker)))) {
      await files.remove(join(this.ended, name));
    }
  }

  /**
   * The charge a step admitted now opens for its class: the minutes its need expects it to run, else
   * {@link DEFAULT_EXPECTED_MINUTES}. None for a step whose ticket names no request, as only a request gives its class's
   * allocation percent.
   */
  private openCharge(waiter: LockWaiter, need: StepNeed | undefined): OpenCharge | undefined {
    const { request } = waiter;
    if (request === undefined) {
      return undefined;
    }
    const at = new Date(this.ports.clock.now()).toISOString();
    return { ticket: waiter.id, class: request.class, pct: request.classPct, at, minutes: need?.expectedMinutes ?? DEFAULT_EXPECTED_MINUTES };
  }

  /** The steps running on the host: the lock's live holder, then the live shares, oldest first (a stale share is removed). */
  private async running(): Promise<HostLockInfo[]> {
    const seen = await this.read();
    const holder = seen.kind === 'held' && !this.isStale(seen.info) ? [seen.info] : [];
    return [...holder, ...(await this.liveShares())];
  }

  /**
   * Holds a lock just taken until the small steps sharing the host end, looking every `FIRST_IN_LINE_POLL_MS`; no new
   * one is let in meanwhile, as the lock is held. Gives up, releasing the lock, when its wait runs out (no small step
   * ended for its whole length) or the lock would expire, so it never goes stale while held, and when its ticket was
   * withdrawn meanwhile. A lock that waited is renewed, so its step gets its whole time. Once `stop` aborts it releases
   * the lock and rejects with the stop's reason.
   */
  private async drain(lock: HostLockInfo, ticket: OwnTicket, patience: Patience, reports: WaitReports, stop: AbortSignal | undefined): Promise<Taking> {
    const { clock, sleep } = this.ports;
    const expiry = Date.parse(lock.expiresAt);
    let waited = false;
    for (;;) {
      if (stop?.aborted === true) {
        await this.release(lock);
        stop.throwIfAborted();
      }
      const shares = await this.liveShares();
      if (shares.length === 0) {
        return { kind: 'taken', lock: waited ? await this.renew(lock) : lock };
      }
      const holder: LockWait = { kind: 'draining', shares };
      const waitingOn = reports.report(holder, 0, clock.now());
      if (!(await this.waitOn(ticket, patience, standingBehind([], holder), waitingOn))) {
        await this.release(lock);
        return { kind: 'withdrawn' };
      }
      const left = Math.min(patience.deadline, expiry) - clock.now();
      if (left <= 0) {
        await this.release(lock);
        return { kind: 'busy', holder };
      }
      waited = true;
      await sleep(Math.min(FIRST_IN_LINE_POLL_MS, left));
      if ((await this.ports.files.read(join(this.queue, ticket.name))) === undefined) {
        await this.release(lock);
        return { kind: 'withdrawn' };
      }
    }
  }

  /**
   * A step that took its turn removes its own ticket to run: when a withdraw removed it first, the lock or share just
   * taken is released and the step is withdrawn.
   */
  private async commit(taken: Extract<Taking, { kind: 'taken' }>, ticket: OwnTicket): Promise<Taking> {
    if (await this.ports.files.remove(join(this.queue, ticket.name))) {
      return taken;
    }
    await this.release(taken.lock);
    return { kind: 'withdrawn' };
  }

  /**
   * Takes in a look that found this step behind the steps `behind`, with what it waits on when that is new: when the
   * line moved, its wait runs out later and its ticket says so, so no waiter removes it as stale meanwhile; a new
   * `waitingOn` goes in the same write. False when its ticket was withdrawn.
   */
  private async waitOn(ticket: OwnTicket, patience: Patience, behind: ReadonlySet<string>, waitingOn: WaitingOn | undefined): Promise<boolean> {
    const moved = patience.look(behind, this.ports.clock.now());
    if (!moved && waitingOn === undefined) {
      return true;
    }
    const expiresAt = ticketExpiry(patience.deadline);
    return this.rewrite(ticket, waitingOn === undefined ? { ...ticket.waiter, expiresAt } : { ...ticket.waiter, expiresAt, waitingOn });
  }

  /**
   * Writes this step's ticket again as `waiter`, keeping its place: its wait's new end, or what it now waits on. The
   * ticket is removed and written again: the removal fails when a withdraw removed it first, so a withdrawn ticket never
   * comes back (false then). Meanwhile, for a moment, the line misses it, so a ticket is written again only on a change.
   */
  private async rewrite(ticket: OwnTicket, waiter: LockWaiter): Promise<boolean> {
    const path = join(this.queue, ticket.name);
    if (!(await this.ports.files.remove(path))) {
      return false;
    }
    await this.ports.files.write(path, stored(waiter));
    ticket.waiter = waiter;
    return true;
  }

  /** Removes a ticket: true when this call removed it. One being renewed (`extend`) is away for a moment, so a ticket back in line is tried once more. */
  private async removeTicket(name: string): Promise<boolean> {
    const path = join(this.queue, name);
    const { files } = this.ports;
    return (await files.remove(path)) || ((await files.list(this.queue)).includes(name) && (await files.remove(path)));
  }

  /** The lock this step holds, its expiry moved to a whole TTL from now. */
  private async renew(lock: HostLockInfo): Promise<HostLockInfo> {
    const renewed: HostLockInfo = { ...lock, expiresAt: new Date(this.ports.clock.now() + this.ttlMs).toISOString() };
    await this.ports.files.write(this.path, stored(renewed));
    return renewed;
  }

  /**
   * One look in line for a step that shares the host as `hold` says, with `need`. A live lock is waited on, and so is an
   * earlier waiter, and a heavy step waits while `cap` heavy steps share the host. Else the step shares the host, under
   * its ticket's id, holding its need's MB ({@link heldMbOf}), once the memory gate finds room for it beside the steps
   * already sharing it (at once with no gate); a stale lock is left for the next step that takes the lock.
   */
  private async shareInTurn(waiter: LockWaiter, ahead: readonly LockWaiter[], removeUnknown: boolean, need: StepNeed | undefined, hold: Exclude<Hold, { kind: 'whole' }>): Promise<Look> {
    const seen = await this.read();
    if (seen.kind === 'held' && !this.isStale(seen.info)) {
      return { kind: 'busy', holder: await this.heldBy(seen.info) };
    }
    const [first] = ahead;
    if (first !== undefined) {
      return { kind: 'busy', holder: seen.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'queued', first } };
    }
    if (seen.kind === 'unknown') {
      if (!removeUnknown) {
        return { kind: 'busy', holder: { kind: 'unknown' } };
      }
      await this.removeAt(this.path, (text) => text === seen.text);
    }
    const others = await this.liveShares();
    const heavy = hold.kind === 'heavy';
    if (heavy) {
      const running = others.filter(isHeavyShare);
      if (running.length >= hold.cap) {
        return { kind: 'busy', holder: { kind: 'heavyCap', cap: hold.cap, running } };
      }
      // A heavy step alone on the host is never held on CPU: a host the day's other work keeps busy would never ship.
      if (running.length > 0 && this.ports.cpu !== undefined) {
        const cpu = await this.ports.cpu.look();
        if (cpu.kind === 'cpu') {
          return { kind: 'busy', holder: { ...cpu, running } };
        }
      }
    }
    const look = await this.lookAtMemory(need, others);
    if (look !== undefined && look.kind !== 'room') {
      return { kind: 'busy', holder: { ...look, shares: others } };
    }
    const share: HostShare = {
      ...this.newLock(waiter.session, waiter.purpose, waiter.id),
      reserveMb: this.heldMbOf(need),
      ...(heavy ? { heavy: true } : {}),
      ...(waiter.request === undefined ? {} : { request: waiter.request }),
    };
    await this.ports.files.write(join(this.shared, `${share.id}.json`), stored(share));
    return { kind: 'taken', lock: share, sharing: look === undefined ? { others, heavy } : { freeMb: look.freeMb, others, heavy } };
  }

  /** The MB held for a step with `need` while it runs: its reserve, else the gate's `heavyReserveMb`, else 0 for a lock with no gate. */
  private heldMbOf(need: StepNeed | undefined): number {
    return need?.reserveMb ?? this.ports.memory?.config.heavyReserveMb ?? 0;
  }

  /**
   * The memory gate's look for a step holding its `need`'s MB (the gate's `heavyReserveMb` when it states none) beside
   * the steps sharing the host (`shares`, small or heavy), whose held MB counts as taken; a short look carries the need's `basis`, so its wait line
   * says where the MB came from. Undefined for a lock with no gate.
   */
  private async lookAtMemory(need: StepNeed | undefined, shares: readonly HostShare[]): Promise<MemoryLook | undefined> {
    const { memory } = this.ports;
    if (memory === undefined) {
      return undefined;
    }
    const heldMb = shares.reduce((total, share) => total + share.reserveMb, 0);
    const look = await memory.look(need?.reserveMb ?? memory.config.heavyReserveMb, heldMb);
    return look.kind === 'room' || need?.basis === undefined ? look : { ...look, basis: need.basis };
  }

  /** Every share file, with what it says: undefined when it cannot be read as a share. */
  private async shareFiles(): Promise<{ readonly path: string; readonly share: HostShare | undefined }[]> {
    const { files } = this.ports;
    const found: { readonly path: string; readonly share: HostShare | undefined }[] = [];
    for (const name of (await files.list(this.shared)).filter((entry) => SHARE_NAME.test(entry))) {
      const path = join(this.shared, name);
      const text = await files.read(path);
      if (text !== undefined) {
        found.push({ path, share: parseShare(text) });
      }
    }
    return found;
  }

  /** The live shares, oldest first; a share whose process is gone, that expired or that cannot be read is removed (shares are written whole). */
  private async liveShares(): Promise<HostShare[]> {
    const live: HostShare[] = [];
    for (const { path, share } of await this.shareFiles()) {
      if (share === undefined || this.isStale(share)) {
        await this.ports.files.remove(path);
      } else {
        live.push(share);
      }
    }
    return live.sort(byAcquiredAt);
  }

  /** The share the taking with `id` wrote, and its file; undefined when there is none or the id is no file name. */
  private async shareWith(id: string): Promise<{ readonly path: string; readonly share: HostShare } | undefined> {
    const name = `${id}.json`;
    if (!SHARE_NAME.test(name)) {
      return undefined;
    }
    const path = join(this.shared, name);
    const text = await this.ports.files.read(path);
    const share = text === undefined ? undefined : parseShare(text);
    return share?.id === id ? { path, share } : undefined;
  }

  /**
   * One look in line for a step with `need` (the gate's heavy reserve when undefined). A live holder is named
   * without a write, and a later waiter names the waiter first in line, which the lock goes to next. The first in line
   * takes the lock once the memory gate finds room for it, under its ticket's id so the step keeps one identity from
   * joining the line to releasing the lock; the steps still sharing the host (small or heavy) count as holding their
   * MB, as the step that took the lock waits for them to end.
   */
  private async takeInTurn(waiter: LockWaiter, ahead: readonly LockWaiter[], removeUnknown: boolean, need: StepNeed | undefined): Promise<Look> {
    const seen = await this.read();
    if (seen.kind === 'held' && !this.isStale(seen.info)) {
      return { kind: 'busy', holder: await this.heldBy(seen.info) };
    }
    const [first] = ahead;
    if (first !== undefined) {
      return { kind: 'busy', holder: seen.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'queued', first } };
    }
    if (seen.kind === 'unknown' && !removeUnknown) {
      return { kind: 'busy', holder: { kind: 'unknown' } };
    }
    const shares = await this.liveShares();
    const look = await this.lookAtMemory(need, shares);
    if (look !== undefined && look.kind !== 'room') {
      return { kind: 'busy', holder: { ...look, shares } };
    }
    return this.take(waiter.session, waiter.purpose, removeUnknown, waiter.id);
  }

  /**
   * What the ticket of a step that asks `ask` says it asks: its request, with the MB its need holds ({@link heldMbOf}),
   * whether it is a heavy step and whether it takes the whole host ({@link holdOf}). Undefined without a request.
   */
  private ticketRequestOf(ask: StepAsk): TicketRequest | undefined {
    const { need, request } = ask;
    if (request === undefined) {
      return undefined;
    }
    const hold = this.holdOf(ask);
    return { ...request, needMb: this.heldMbOf(need), heavy: hold.kind !== 'small', exclusive: hold.kind === 'whole' };
  }

  /** Writes this step's ticket at the end of the line, its wait running out at `deadline`, saying what it asks when it names a `request`. */
  private async joinLine(session: string, purpose: string, deadline: number, request: TicketRequest | undefined): Promise<OwnTicket> {
    const now = this.ports.clock.now();
    const waiter: LockWaiter = {
      id: this.ports.newId(),
      pid: this.ports.pid,
      session,
      purpose,
      kit: KIT_VERSION,
      arrivedAt: new Date(now).toISOString(),
      expiresAt: ticketExpiry(deadline),
      stopsOnWithdraw: true,
      ...(request === undefined ? {} : { request }),
    };
    const name = `${String(now).padStart(ARRIVAL_DIGITS, '0')}-${waiter.id}.json`;
    await this.ports.files.write(join(this.queue, name), stored(waiter));
    return { name, waiter };
  }

  /** The live waiters whose tickets come before `ticket`, oldest first; undefined once `ticket` is gone, withdrawn ({@link liveTickets}). */
  private async waitersAhead(ticket: string): Promise<LockWaiter[] | undefined> {
    const names = await this.ports.files.list(this.queue);
    if (!names.includes(ticket)) {
      return undefined;
    }
    return (await this.liveTickets(names.filter((name) => name < ticket))).map(({ waiter }) => waiter);
  }

  /**
   * The live tickets in line, `ticket` among them as this step last wrote it, the others oldest first; undefined once
   * `ticket` is gone, withdrawn ({@link liveTickets}).
   */
  private async liveLine(ticket: OwnTicket): Promise<Ticket[] | undefined> {
    const names = await this.ports.files.list(this.queue);
    if (!names.includes(ticket.name)) {
      return undefined;
    }
    const others = await this.liveTickets(names.filter((name) => name !== ticket.name));
    return [...others, { name: ticket.name, waiter: ticket.waiter }];
  }

  /**
   * The live tickets among the entries `names`, oldest first. A ticket whose process is gone, whose wait ran out or that
   * cannot be read is removed (tickets are written whole); one gone meanwhile left the line.
   */
  private async liveTickets(names: readonly string[]): Promise<Ticket[]> {
    const { files } = this.ports;
    const live: Ticket[] = [];
    for (const name of names.filter((entry) => TICKET_NAME.test(entry)).sort()) {
      const path = join(this.queue, name);
      const text = await files.read(path);
      if (text === undefined) {
        continue;
      }
      const waiter = parseWaiter(text);
      if (waiter === undefined || this.isStale(waiter)) {
        await files.remove(path);
      } else {
        live.push({ name, waiter });
      }
    }
    return live;
  }

  /** The live tickets in line, oldest first, with their names; a stale or unreadable one is left out, and left. */
  private async tickets(): Promise<Ticket[]> {
    const { files } = this.ports;
    const found: Ticket[] = [];
    for (const name of (await files.list(this.queue)).filter((entry) => TICKET_NAME.test(entry)).sort()) {
      const text = await files.read(join(this.queue, name));
      const waiter = text === undefined ? undefined : parseWaiter(text);
      if (waiter !== undefined && !this.isStale(waiter)) {
        found.push({ name, waiter });
      }
    }
    return found;
  }

  private isStale(entry: Pick<HostLockInfo, 'pid' | 'expiresAt'>): boolean {
    return Date.parse(entry.expiresAt) <= this.ports.clock.now() || !this.ports.alive(entry.pid);
  }

  private newLock(session: string, purpose: string, id: string): HostLockInfo {
    const now = this.ports.clock.now();
    return {
      id,
      pid: this.ports.pid,
      session,
      purpose,
      kit: KIT_VERSION,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
  }

  private async read(): Promise<Seen> {
    const text = await this.ports.files.read(this.path);
    if (text === undefined) {
      return { kind: 'missing' };
    }
    const info = parseLock(text);
    return info === undefined ? { kind: 'unknown', text } : { kind: 'held', info };
  }

  /** Removes the file at `path` (the lock) while its text still passes `still`, so one another step wrote meanwhile stays. */
  private async removeAt(path: string, still: (text: string) => boolean): Promise<boolean> {
    const text = await this.ports.files.read(path);
    if (text === undefined || !still(text)) {
      return false;
    }
    await this.ports.files.remove(path);
    return true;
  }
}
