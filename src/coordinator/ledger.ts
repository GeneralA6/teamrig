import type { Files } from '../core/files.ts';

/** The ledger's file name in the coordinator's folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';

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

/** Appends one record as one line, in one write. */
export async function appendHeavy(files: Files, ledger: string, record: HeavyRecord): Promise<void> {
  await files.append(ledger, `${JSON.stringify(record)}\n`);
}
