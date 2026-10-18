import type { CoordinatorRepoConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { formatUtcMinute } from '../core/time.ts';
import { parseClaims, type Claim } from './claims.ts';
import { holderText, type HostLock } from './host-lock.ts';

/** The claims for people to read, beside `claims.json`, and the lock their writers share. */
export const CLAIMS_MD_FILE = 'claims.md';
export const CLAIMS_LOCK_FILE = 'claims.lock';

/** Every target a claim may name: what the team's repositories deploy on push and what their rolls roll, each once. */
export function deployTargetsOf(repos: Readonly<Record<string, CoordinatorRepoConfig>>): string[] {
  return [...new Set(Object.values(repos).flatMap((repo) => [...repo.deploysOnPush, ...(repo.roll?.targets ?? [])]))];
}

/** The claims are written under their own lock, held for one read and write: it lasts 60 s and is waited for 15 s. */
export const CLAIMS_LOCK_TTL_MS = 60_000;
const CLAIMS_LOCK_WAIT_MS = 15_000;
const CLAIMS_LOCK_POLL_MS = 500;

/** The first line of `claims.md`, as the team's own coordinator writes it. */
export const CLAIMS_MD_HEADER = '# Quiet claims: active only until their end time (see README.md, rule 3)';

export interface ClaimPlaces {
  readonly claims: string;
  /** The claims for people to read, rewritten with `claims` each time. */
  readonly claimsMd: string;
}

export interface ClaimPorts {
  readonly files: Pick<Files, 'read' | 'write'>;
  readonly clock: Clock;
  /** The lock on the claims file, which a team's own coordinator takes too. */
  readonly lock: Pick<HostLock, 'acquire' | 'release'>;
}

export interface ClaimRequest {
  readonly session: string;
  readonly targets: readonly string[];
  readonly metric: string;
  readonly why: string;
  readonly minutes: number;
}

export interface ClaimRules {
  readonly maxMinutes: number;
  /** The deploy targets a claim may name: the ones the coordinator's repositories deploy. */
  readonly knownTargets: readonly string[];
  readonly scanner: Pick<SecretScanner, 'refusal'>;
}

/** How a change to the claims ended: done, refused for good, or not made because another writer held the claims. */
export type ClaimOutcome<T> = { readonly kind: 'done'; readonly value: T } | { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'busy'; readonly reason: string };

type ClaimsChange<T> = { readonly kind: 'write'; readonly claims: readonly Claim[]; readonly value: T } | { readonly kind: 'refused'; readonly reason: string };

/** Text on one line, its runs of whitespace one space, since each claim is one line of `claims.md`. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Why a claim cannot be made whatever the claims file holds; undefined when it can. */
export function claimRefusal(request: ClaimRequest, rules: ClaimRules): string | undefined {
  if (!Number.isInteger(request.minutes) || request.minutes <= 0 || request.minutes > rules.maxMinutes) {
    return `a claim lasts 1 to ${rules.maxMinutes} minutes (asked ${request.minutes})`;
  }
  if (request.targets.length === 0) {
    return 'a claim names at least one deploy target';
  }
  const unknown = request.targets.filter((target) => !rules.knownTargets.includes(target));
  if (unknown.length > 0) {
    const known = rules.knownTargets.length === 0 ? 'none are configured' : `known: ${rules.knownTargets.join(', ')}`;
    return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a deploy target' : 'are not deploy targets'} of this team (${known})`;
  }
  if (oneLine(request.metric) === '') {
    return 'a claim names the metric it measures';
  }
  if (oneLine(request.why) === '') {
    return 'a claim says why it holds deploys';
  }
  return rules.scanner.refusal('the metric', request.metric) ?? rules.scanner.refusal('the reason', request.why);
}

/** An ISO time as `claims.md` shows it, `2030-01-08 10:00`; text that is no time stays as it is. */
function shownTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : formatUtcMinute(new Date(at));
}

/** `claims.md`: its header, then `- <from> → <until> | <session> | <targets> | <metric> | <why>` a claim, times in UTC. */
export function renderClaimsMd(claims: readonly Claim[]): string {
  const lines = claims.map((claim) => `- ${shownTime(claim.from)} → ${shownTime(claim.until)} | ${claim.session} | ${claim.targets.join(',')} | ${claim.metric} | ${claim.why}`);
  return `${[CLAIMS_MD_HEADER, ...lines].join('\n')}\n`;
}

/**
 * Reads the claims under their lock, drops the ended ones, applies `change` and writes both files. An unreadable
 * claims file is left as it is and the change refused, since writing over it would drop the claims it holds.
 */
async function changeClaims<T>(ports: ClaimPorts, places: ClaimPlaces, session: string, change: (active: readonly Claim[]) => ClaimsChange<T>): Promise<ClaimOutcome<T>> {
  const taking = await ports.lock.acquire(session, 'claims write', CLAIMS_LOCK_WAIT_MS, CLAIMS_LOCK_POLL_MS, () => undefined);
  if (taking.kind === 'busy') {
    return { kind: 'busy', reason: `the claims are being written (${holderText(taking.holder)}); try again` };
  }
  try {
    const read = parseClaims(await ports.files.read(places.claims));
    if (read.kind === 'unreadable') {
      return { kind: 'refused', reason: `${places.claims} is unreadable (${read.reason}), so it is left as it is` };
    }
    const now = ports.clock.now();
    const changed = change(read.claims.filter((claim) => Date.parse(claim.until) > now));
    if (changed.kind === 'refused') {
      return changed;
    }
    await ports.files.write(places.claims, `${JSON.stringify(changed.claims, null, 2)}\n`);
    await ports.files.write(places.claimsMd, renderClaimsMd(changed.claims));
    return { kind: 'done', value: changed.value };
  } finally {
    await ports.lock.release(taking.lock);
  }
}

/** Adds the session's claim, from now for `minutes`: one claim a session at a time. */
export async function addClaim(ports: ClaimPorts, places: ClaimPlaces, rules: ClaimRules, request: ClaimRequest): Promise<ClaimOutcome<Claim>> {
  const refusal = claimRefusal(request, rules);
  if (refusal !== undefined) {
    return { kind: 'refused', reason: refusal };
  }
  return changeClaims(ports, places, request.session, (active) => {
    const own = active.find((claim) => claim.session === request.session);
    if (own !== undefined) {
      return { kind: 'refused', reason: `${request.session} already holds a claim until ${shownTime(own.until)} UTC; release it first (one per session)` };
    }
    const now = ports.clock.now();
    const claim: Claim = {
      session: request.session,
      targets: [...request.targets],
      metric: oneLine(request.metric),
      why: oneLine(request.why),
      from: new Date(now).toISOString(),
      until: new Date(now + request.minutes * 60_000).toISOString(),
    };
    return { kind: 'write', claims: [...active, claim], value: claim };
  });
}

/** Ends the session's claim; done with the claim it ended, or undefined when it held none. */
export async function releaseClaim(ports: ClaimPorts, places: ClaimPlaces, session: string): Promise<ClaimOutcome<Claim | undefined>> {
  return changeClaims(ports, places, session, (active) => ({
    kind: 'write',
    claims: active.filter((claim) => claim.session !== session),
    value: active.find((claim) => claim.session === session),
  }));
}
