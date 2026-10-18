import { join } from 'node:path';
import type { Files } from '../core/files.ts';
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
}
