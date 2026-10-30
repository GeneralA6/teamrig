import type { Files } from '../core/files.ts';
import { isRecord, isStringArray, stringField } from '../core/guards.ts';
import type { TimeZone } from '../core/zone.ts';

/** The deploy freezes' file in the coordinator's folder, named for their old name, quiet claims: one JSON array, written whole. */
export const CLAIMS_FILE = 'claims.json';

/**
 * A deploy freeze: a session measuring `metric` on `targets` until `until`, so a deploy touching one of them waits for
 * its end. Its fields are the ones a team's own coordinator writes too.
 */
export interface Claim {
  readonly session: string;
  readonly targets: readonly string[];
  readonly metric: string;
  readonly why: string;
  /** An ISO time. */
  readonly from: string;
  /** An ISO time; the freeze holds until then. */
  readonly until: string;
}

/** The freezes file as read: its freezes (none when it does not exist), or why it could not be read. */
export type ClaimsRead = { readonly kind: 'read'; readonly claims: readonly Claim[] } | { readonly kind: 'unreadable'; readonly reason: string };

function claimOf(value: unknown): Claim | undefined {
  if (!isRecord(value) || !isStringArray(value['targets'])) {
    return undefined;
  }
  const [session, metric, why, from, until] = ['session', 'metric', 'why', 'from', 'until'].map((key) => stringField(value, key));
  if (session === undefined || metric === undefined || why === undefined || from === undefined || until === undefined) {
    return undefined;
  }
  return { session, targets: value['targets'], metric, why, from, until };
}

/**
 * The freezes in the file's text; an entry missing a field is skipped, as its writer skips one. Text that is no JSON
 * array (a file caught mid-write) is unreadable, never "no freezes", so a deploy waits rather than runs through a freeze.
 */
export function parseClaims(text: string | undefined): ClaimsRead {
  if (text === undefined) {
    return { kind: 'read', claims: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'not JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'not a JSON array' };
  }
  return { kind: 'read', claims: parsed.flatMap((value) => claimOf(value) ?? []) };
}

export async function readClaims(files: Pick<Files, 'read'>, path: string): Promise<ClaimsRead> {
  return parseClaims(await files.read(path));
}

/** The freezes still holding at `nowMs` that name one of `targets`. */
export function coveringClaims(claims: readonly Claim[], targets: readonly string[], nowMs: number): Claim[] {
  return claims.filter((claim) => Date.parse(claim.until) > nowMs && claim.targets.some((target) => targets.includes(target)));
}

/** When a freeze ends, on `zone`'s clock; a stored end that is not a time is shown as written. */
export function claimEndText(until: string, zone: TimeZone): string {
  const at = Date.parse(until);
  return Number.isNaN(at) ? until : zone.minute(new Date(at));
}

/** `by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`: who holds a freeze, on what, until when (on `zone`'s clock) and for what. */
function heldText(claim: Claim, zone: TimeZone): string {
  return `by ${claim.session} on ${claim.targets.join(',')} until ${claimEndText(claim.until, zone)} (${claim.metric})`;
}

/** `deploy freeze by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`, the reason a merge or a deploy waits. */
export function freezeText(claim: Claim, zone: TimeZone): string {
  return `deploy freeze ${heldText(claim, zone)}`;
}

/**
 * `quiet claim by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`, a freeze's line in `teamrig deploy-status`,
 * which keeps the old name of a deploy freeze (T1308): outside tools read that page, and its lines change only after
 * they are told.
 */
export function quietClaimText(claim: Claim, zone: TimeZone): string {
  return `quiet claim ${heldText(claim, zone)}`;
}
