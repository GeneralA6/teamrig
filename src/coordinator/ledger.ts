import type { Files } from '../core/files.ts';
import { formatUtcMinute } from '../core/time.ts';

/** The ledger's file name in the coordinator's folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';

/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';

/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: rolled at (UTC) | session | repo | range | what | kind | note';

/**
 * A heavy step in the ledger, in the format a team's own coordinator writes too: once when it starts (`endedAt`
 * and `exitCode` null), and again with both when it ends, under the same `id`.
 */
export interface HeavyRecord {
  readonly type: 'heavy';
  readonly id: string;
  readonly session: string;
  readonly what: string;
  /** An ISO time. */
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
}

/**
 * A deploy in the ledger, in the format a team's own coordinator writes too. `range` is the commits it landed,
 * `<first>..<last>` by 8-character sha; `rolledAt` is when it went live, for a host that deploys on push when the push
 * ended.
 */
export interface DeployRecord {
  readonly type: 'deploy';
  /** `rollback` is written by a team's own coordinator only, so far. */
  readonly kind: 'deploy' | 'rollback';
  readonly session: string;
  readonly repo: string;
  readonly range: string;
  readonly what: string;
  readonly note: string;
  /** An ISO time. */
  readonly startedAt: string;
  /** An ISO time. */
  readonly rolledAt: string;
}

/** The two ledger files a deploy is written to. */
export interface LedgerPlaces {
  readonly ledger: string;
  readonly ledgerMd: string;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The landed commits as the ledger names them: `<first>..<last>` by 8-character sha, or the one commit. */
export function rangeText(commits: readonly string[], fallback: string): string {
  const first = commits[0];
  const last = commits[commits.length - 1];
  if (first === undefined || last === undefined) {
    return short(fallback);
  }
  return first === last ? short(first) : `${short(first)}..${short(last)}`;
}

/** Appends one record as one line, in one write. */
export async function appendHeavy(files: Files, ledger: string, record: HeavyRecord): Promise<void> {
  await files.append(ledger, `${JSON.stringify(record)}\n`);
}

/** A deploy's ledger.md line, `- <rolled at> | session | repo | range | what | kind | note`; a `|` or line break in a field becomes `/`. */
export function ledgerLine(record: DeployRecord): string {
  const fields = [record.session, record.repo, record.range, record.what, record.kind, record.note].map((field) => field.replace(/[|\r\n]/g, '/'));
  return `- ${formatUtcMinute(new Date(record.rolledAt))} | ${fields.join(' | ')}`;
}

/** Appends a deploy to the JSON ledger and its line to ledger.md, starting a missing ledger.md with its header. */
export async function appendDeploy(files: Files, places: LedgerPlaces, record: DeployRecord): Promise<void> {
  await files.append(places.ledger, `${JSON.stringify(record)}\n`);
  await files.createExclusive(places.ledgerMd, `${LEDGER_MD_HEADER}\n`);
  await files.append(places.ledgerMd, `${ledgerLine(record)}\n`);
}
