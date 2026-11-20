import { isRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { parseIssueTarget, type IssueTarget } from '../issues/host.ts';
import { bareRef } from '../issues/ref.ts';
import { issueRef } from './map.ts';

/**
 * The issues and pull requests each session follows (`teamrig follow`), kept pure: the automatic sync tells a
 * follower their activity as it tells a task's owner the activity of the item its task holds (activity.ts). The
 * file holds refs only, never text read from GitHub.
 */

/** The format of the follows file this code writes; a file in another format reads as following nothing. */
export const FOLLOWS_FORMAT = 1;

/** By session, the refs (`gh:owner/name#n`, the repository in lowercase) it follows, oldest follow first. */
export type Follows = ReadonlyMap<string, readonly string[]>;

/** The item `text` names as `owner/name#n` or as its ref `gh:owner/name#n`, or undefined when it names none. */
export function followTarget(text: string): IssueTarget | undefined {
  return parseIssueTarget(bareRef(text.trim()));
}

/** The follows a file holds; a ref that names no item is left out, and a missing or damaged file follows nothing. */
export function parseFollows(text: string): Map<string, string[]> {
  const record = parseObject(text.trim());
  const follows = record?.[VERSION_FIELD] === FOLLOWS_FORMAT ? record['follows'] : undefined;
  if (!isRecord(follows)) {
    return new Map();
  }
  const parsed = new Map<string, string[]>();
  for (const [session, refs] of Object.entries(follows)) {
    const kept = Array.isArray(refs) ? [...new Set(refs.flatMap(refOf))] : [];
    if (kept.length > 0) {
      parsed.set(session, kept);
    }
  }
  return parsed;
}

function refOf(value: unknown): string[] {
  const target = typeof value === 'string' ? followTarget(value) : undefined;
  return target === undefined ? [] : [issueRef(target.repo, target.number)];
}

/** The follows as the file's one line, sessions in name order, a session that follows nothing left out. */
export function formatFollows(follows: Follows): string {
  const kept = [...follows].filter(([, refs]) => refs.length > 0).sort(([a], [b]) => a.localeCompare(b));
  return toJsonlLine({ [VERSION_FIELD]: FOLLOWS_FORMAT, follows: Object.fromEntries(kept) });
}

/** What a follow did: the follows with it added, or why they stay as they were. */
export type FollowChange =
  | { readonly kind: 'followed'; readonly follows: Follows }
  | { readonly kind: 'already' }
  | { readonly kind: 'full'; readonly max: number };

/** `session` follows `ref` too, unless it already does or follows `max` items already. */
export function addFollow(follows: Follows, session: string, ref: string, max: number): FollowChange {
  const own = follows.get(session) ?? [];
  if (own.includes(ref)) {
    return { kind: 'already' };
  }
  if (own.length >= max) {
    return { kind: 'full', max };
  }
  return { kind: 'followed', follows: new Map([...follows, [session, [...own, ref]]]) };
}

/** The follows without `session` following `ref`, or undefined when it did not follow it. */
export function dropFollow(follows: Follows, session: string, ref: string): Follows | undefined {
  const own = follows.get(session) ?? [];
  if (!own.includes(ref)) {
    return undefined;
  }
  return new Map([...follows, [session, own.filter((held) => held !== ref)]]);
}

/** By ref, the sessions following it, in session order, so the sync looks up an item's followers at once. */
export function followersOf(follows: Follows): Map<string, string[]> {
  const byRef = new Map<string, string[]>();
  for (const [session, refs] of [...follows].sort(([a], [b]) => a.localeCompare(b))) {
    for (const ref of refs) {
      byRef.set(ref, [...(byRef.get(ref) ?? []), session]);
    }
  }
  return byRef;
}
