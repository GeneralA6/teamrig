import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isStringArray, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { isReviewClearance, type ReviewClearance } from './review-gate-step.ts';
import { isSelfMergeGate, type SelfMergeGate } from './self-merge.ts';

/**
 * The team's append-only log of what `teamrig merge` merged under `pushGuard.pushToProtected: gated` (T800 §2.1,
 * T858), `merges.jsonl` in the delivery folder, oldest first: one record a merged change, whether every gate held
 * or a leader approved the gates it missed, so the meeting digest and an audit read what merged with no click.
 */

/** The format of the log's records; a newer one is skipped on read and refuses a write. */
export const MERGE_FORMAT = 1;

interface LandedChange {
  /** When it landed (ISO). */
  readonly at: string;
  readonly session: string;
  readonly repo: string;
  readonly branch: string;
  /** The task the branch names; undefined when it names none. */
  readonly task: string | undefined;
  /** The default branch it landed on, as it was before the push. */
  readonly base: string;
  readonly head: string;
  readonly tree: string;
  /** The files `base..head` changed, and their changed lines (a binary file counts none). */
  readonly files: number;
  readonly lines: number;
  /** The checks the tree's pass record lists; empty when none proved it. */
  readonly checks: readonly string[];
  /** How the review gate let it go; `checked` is a change only the review check looked at, which security samples. */
  readonly review: ReviewClearance;
}

/** Every gate held, so the change landed with no click. */
export interface SelfMerge extends LandedChange {
  readonly route: 'self';
}

/** A leader approved the gates the change missed. */
export interface ApprovedMerge extends LandedChange {
  readonly route: 'approved';
  readonly missed: readonly SelfMergeGate[];
  readonly approvedBy: string;
}

export type MergeRecord = SelfMerge | ApprovedMerge;

/** One landed change as the log's JSON record. */
export function mergeRecordOf(record: MergeRecord): JsonRecord {
  const { at, session, repo, branch, task, base, head, tree, files, lines, checks, review } = record;
  const landed = { [VERSION_FIELD]: MERGE_FORMAT, at, session, repo, branch, task: task ?? null, base, head, tree, files, lines, checks, review, route: record.route };
  return record.route === 'self' ? landed : { ...landed, missed: record.missed, approvedBy: record.approvedBy };
}

const isGateList = (value: unknown): value is readonly SelfMergeGate[] => Array.isArray(value) && value.length > 0 && value.every(isSelfMergeGate);

const TEXT_FIELDS = ['at', 'session', 'repo', 'branch', 'base', 'head', 'tree'] as const;

/** One record as a landed change; undefined when it is damaged. */
export function parseMergeRecord(record: JsonRecord): MergeRecord | undefined {
  const [at, session, repo, branch, base, head, tree] = TEXT_FIELDS.map((key) => stringField(record, key));
  const { task, files, lines, checks, review, route, missed } = record;
  const approvedBy = stringField(record, 'approvedBy');
  if (
    at === undefined ||
    !Number.isFinite(Date.parse(at)) ||
    session === undefined ||
    repo === undefined ||
    branch === undefined ||
    base === undefined ||
    head === undefined ||
    tree === undefined ||
    (task !== null && typeof task !== 'string') ||
    !isNonNegativeInteger(files) ||
    !isNonNegativeInteger(lines) ||
    !isStringArray(checks) ||
    !isReviewClearance(review)
  ) {
    return undefined;
  }
  const landed: LandedChange = { at, session, repo, branch, task: task ?? undefined, base, head, tree, files, lines, checks, review };
  if (route === 'self') {
    return { ...landed, route };
  }
  return route === 'approved' && isGateList(missed) && approvedBy !== undefined ? { ...landed, route, missed, approvedBy } : undefined;
}

export interface MergeLogRead {
  readonly records: readonly MergeRecord[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

/** The team's append-only log of landed changes, oldest first. */
export class MergeLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<MergeLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const records: MergeRecord[] = [];
    for (const { record, version } of parse.records) {
      const parsed = version === MERGE_FORMAT ? parseMergeRecord(record) : undefined;
      if (parsed !== undefined) {
        records.push(parsed);
      }
    }
    return { records, skipped: parse.unreadable + parse.records.length - records.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: MergeRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), MERGE_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(mergeRecordOf(record))}`);
  }
}
