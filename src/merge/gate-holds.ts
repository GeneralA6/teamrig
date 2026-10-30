import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { changeHash, type HeldChange } from './review-holds.ts';
import { isSelfMergeGate, type GateMiss } from './self-merge.ts';

/**
 * The self-merge gates' holds (T800 §2.1, T858): a change that missed a gate under `pushToProtected: gated`, kept until
 * a leader approves its task or the branch lands. One file per repository and branch, in their own folder in the
 * delivery folder (`DeliveryPlaces.gateHolds`), apart from the review holds, so neither replaces the other; a new hold
 * of a branch replaces its old one, as the change it bound moved on.
 */

export interface GateHold extends HeldChange {
  /** `G` and 12 hex digits of the change's hash: what the task's note names. */
  readonly id: string;
  /** The task the branch belongs to (`t<n>-…`), whose approval answers the hold. */
  readonly task: string;
  readonly session: string;
  /** The leader who answers it. */
  readonly reviewer: string;
  /** The gates it missed when it was made: an approval covers these and no other. */
  readonly misses: readonly GateMiss[];
  /** When the hold was made (ISO): an approval counts only after it. */
  readonly createdAt: string;
}

/** The hold's id: the same change always gets the same one. */
export function gateHoldId(change: HeldChange): string {
  return `G${changeHash(change)}`;
}

/** Reads and writes the holds in one folder. */
export class GateHolds {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** The branch's hold; undefined when it has none or its file does not read as one, which a new hold replaces. */
  async read(repo: string, branch: string): Promise<GateHold | undefined> {
    return parseGateHold(await this.files.read(this.pathOf(repo, branch)));
  }

  async write(hold: GateHold): Promise<void> {
    await this.files.write(this.pathOf(hold.repo, hold.branch), `${JSON.stringify(hold, null, 2)}\n`);
  }

  /** Removes the branch's hold once it landed: true when it had one. */
  async remove(repo: string, branch: string): Promise<boolean> {
    return this.files.remove(this.pathOf(repo, branch));
  }

  private pathOf(repo: string, branch: string): string {
    return join(this.dir, `${encodeURIComponent(repo)}~${encodeURIComponent(branch)}.json`);
  }
}

const HOLD_TEXT_FIELDS = ['id', 'repo', 'branch', 'base', 'head', 'tree', 'task', 'session', 'reviewer', 'createdAt'] as const;

function parseMiss(value: unknown): GateMiss | undefined {
  const gate = isRecord(value) ? value['gate'] : undefined;
  const why = isRecord(value) ? stringField(value, 'why') : undefined;
  return isSelfMergeGate(gate) && why !== undefined ? { gate, why } : undefined;
}

function parseMisses(value: unknown): GateMiss[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const misses = value.map(parseMiss);
  return misses.every((miss): miss is GateMiss => miss !== undefined) ? misses : undefined;
}

export function parseGateHold(text: string | undefined): GateHold | undefined {
  let value: unknown;
  try {
    value = text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const record: JsonRecord = value;
  const [id, repo, branch, base, head, tree, task, session, reviewer, createdAt] = HOLD_TEXT_FIELDS.map((key) => stringField(record, key));
  const misses = parseMisses(record['misses']);
  if (
    id === undefined ||
    repo === undefined ||
    branch === undefined ||
    base === undefined ||
    head === undefined ||
    tree === undefined ||
    task === undefined ||
    session === undefined ||
    reviewer === undefined ||
    createdAt === undefined ||
    misses === undefined
  ) {
    return undefined;
  }
  return { id, repo, branch, base, head, tree, task, session, reviewer, misses, createdAt };
}
