import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isReviewClass, type ReviewClass } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { Reviewer } from '../push-guard/review-gate.ts';

/**
 * The review gate's holds (T800 §2.2, T828): a change the gate held, kept until its reviewer approves it or the branch
 * lands. One file per repository and branch, in the coordinator's folder (`DeliveryPlaces.reviewHolds`), so their
 * count stays the branches in flight; a new hold of a branch replaces its old one, as the change it bound moved on.
 */

/** A change as a hold binds it: the commits `base..head` of one branch and the tree they make. */
export interface HeldChange {
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly tree: string;
}

/** A path of the change and the review glob that covers it. */
export interface HoldHit {
  readonly path: string;
  readonly glob: string;
}

export interface ReviewHold extends HeldChange {
  /** `H` and 12 hex digits of the change's hash: what the task's note names. */
  readonly id: string;
  /** The task the branch belongs to (`t<n>-…`), whose approval answers the hold. */
  readonly task: string;
  readonly session: string;
  readonly holdClass: ReviewClass;
  readonly reviewer: Reviewer;
  readonly hits: readonly HoldHit[];
  /** What a flagging review check printed, redacted; undefined when no check flagged it. */
  readonly findings: string | undefined;
  /** When the hold was made (ISO): an approval counts only after it. */
  readonly createdAt: string;
}

/** 12 hex digits of the change's hash: the same change always gets the same ones. */
export function changeHash(change: HeldChange): string {
  const { repo, branch, base, head, tree } = change;
  return createHash('sha256').update([repo, branch, base, head, tree].join('\0')).digest('hex').slice(0, 12);
}

/** The hold's id: the same change always gets the same one. */
export function holdId(change: HeldChange): string {
  return `H${changeHash(change)}`;
}

/** Whether the hold binds this very change: the same commits on the same branch, making the same tree. */
export function holdBinds(hold: HeldChange, change: HeldChange): boolean {
  return hold.repo === change.repo && hold.branch === change.branch && hold.base === change.base && hold.head === change.head && hold.tree === change.tree;
}

/** Reads and writes the holds in one folder. */
export class ReviewHolds {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** The branch's hold; undefined when it has none or its file does not read as one, which a new hold replaces. */
  async read(repo: string, branch: string): Promise<ReviewHold | undefined> {
    return parseHold(await this.files.read(this.pathOf(repo, branch)));
  }

  async write(hold: ReviewHold): Promise<void> {
    await this.files.write(this.pathOf(hold.repo, hold.branch), `${JSON.stringify(storedHold(hold), null, 2)}\n`);
  }

  /** Removes the branch's hold once it landed: true when it had one. */
  async remove(repo: string, branch: string): Promise<boolean> {
    return this.files.remove(this.pathOf(repo, branch));
  }

  private pathOf(repo: string, branch: string): string {
    return join(this.dir, `${encodeURIComponent(repo)}~${encodeURIComponent(branch)}.json`);
  }
}

function storedHold(hold: ReviewHold): JsonRecord {
  return {
    ...hold,
    reviewer: { who: hold.reviewer.who, fallback: hold.reviewer.fallback ?? null },
    hits: hold.hits.map(({ path, glob }) => ({ path, glob })),
    findings: hold.findings ?? null,
  };
}

const HOLD_TEXT_FIELDS = ['id', 'repo', 'branch', 'base', 'head', 'tree', 'task', 'session', 'createdAt'] as const;

function parseHold(text: string | undefined): ReviewHold | undefined {
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const [id, repo, branch, base, head, tree, task, session, createdAt] = HOLD_TEXT_FIELDS.map((key) => stringField(value, key));
  const holdClass = value['holdClass'];
  const reviewer = parseReviewer(recordField(value, 'reviewer'));
  const hits = parseHits(value['hits']);
  const findings = value['findings'];
  if (
    id === undefined ||
    repo === undefined ||
    branch === undefined ||
    base === undefined ||
    head === undefined ||
    tree === undefined ||
    task === undefined ||
    session === undefined ||
    createdAt === undefined ||
    !isReviewClass(holdClass) ||
    reviewer === undefined ||
    hits === undefined ||
    (findings !== null && typeof findings !== 'string')
  ) {
    return undefined;
  }
  return { id, repo, branch, base, head, tree, task, session, holdClass, reviewer, hits, findings: findings ?? undefined, createdAt };
}

function parseReviewer(record: JsonRecord | undefined): Reviewer | undefined {
  const who = record === undefined ? undefined : stringField(record, 'who');
  const fallback = record?.['fallback'];
  if (who === undefined || (fallback !== null && typeof fallback !== 'string')) {
    return undefined;
  }
  return { who, fallback: fallback ?? undefined };
}

function parseHits(value: unknown): HoldHit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const hits: HoldHit[] = [];
  for (const item of value) {
    const path = isRecord(item) ? stringField(item, 'path') : undefined;
    const glob = isRecord(item) ? stringField(item, 'glob') : undefined;
    if (path === undefined || glob === undefined) {
      return undefined;
    }
    hits.push({ path, glob });
  }
  return hits;
}
