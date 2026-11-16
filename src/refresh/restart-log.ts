import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { recordField, stringField } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import type { TeamPaths } from '../core/home.ts';
import type { RestartResult } from './restart.ts';

/** One automatic restart, as the restart log keeps it. */
export interface RestartRecord {
  readonly session: string;
  /** When the Stop hook asked for the restart (its `--at`). */
  readonly at: string;
  /** When the restart ended, with `result`. */
  readonly endedAt: string;
  readonly result: RestartResult;
}

/**
 * Every automatic restart's outcome, one JSON line each in the team's `refresh/restarts.jsonl`. The restart
 * runs hidden and only a failure reaches the session's inbox, so this is what a trial or a live week of
 * refreshes is judged on (stuck, duplicate or lost sessions). About 9 lines a day for 12 sessions.
 */
export class RestartLog {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, paths: Pick<TeamPaths, 'refresh'>) {
    this.files = files;
    this.path = join(paths.refresh, 'restarts.jsonl');
  }

  record(entry: RestartRecord): Promise<void> {
    return this.files.append(this.path, `${JSON.stringify(entry)}\n`);
  }

  /** The newest row of `session`, as `check` names it (#705); undefined with none, damaged rows skipped. */
  async lastRowOf(session: string): Promise<RestartRow | undefined> {
    const lines = ((await this.files.read(this.path)) ?? '').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const row = rowOf(lines[index] ?? '');
      if (row !== undefined && row.session === session) {
        return row;
      }
    }
    return undefined;
  }
}

/** A restart-log row as `check` reads it: when it ended, its result's kind and its `why` when it has one. */
export interface RestartRow {
  readonly session: string;
  readonly endedAt: string;
  readonly kind: string;
  readonly why: string | null;
}

function rowOf(line: string): RestartRow | undefined {
  const record = parseObject(line.trim());
  const result = record === undefined ? undefined : recordField(record, 'result');
  const session = record === undefined ? undefined : stringField(record, 'session');
  const endedAt = record === undefined ? undefined : stringField(record, 'endedAt');
  const kind = result === undefined ? undefined : stringField(result, 'kind');
  if (result === undefined || session === undefined || endedAt === undefined || kind === undefined) {
    return undefined;
  }
  return { session, endedAt, kind, why: stringField(result, 'why') ?? null };
}
