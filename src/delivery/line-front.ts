import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';
import { TASK_ID } from '../register/model.ts';

/**
 * The one task whose queued steps go first in the host lock's line (T4082): a blocker's fix, put there by the team's
 * lead with `teamrig pipeline front <task>`, so it no longer waits behind every step that queued before it. One at a
 * time: a new front replaces the last. `at` is when it was put there, which orders two teams' fronts in the host-wide
 * line; `by` is the lead who put it.
 */
export interface LineFront {
  readonly task: string;
  readonly at: string;
  readonly by: string;
}

/** The team's front file, in its state folder: each team's lead fronts only its own team's tasks. */
export const LINE_FRONT_FILE = 'line-front.json';

/** The path of the front file in the team's state folder `state`. */
export function lineFrontPath(state: string): string {
  return join(state, LINE_FRONT_FILE);
}

/** A front as its file stores it; a field another kit adds is ignored. */
export function isLineFront(value: unknown): value is LineFront {
  if (!isRecord(value)) {
    return false;
  }
  const { task, at, by } = value;
  return typeof task === 'string' && TASK_ID.test(task) && typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof by === 'string';
}

/**
 * The team's front file. A file that does not parse (one being replaced, a hand edit) reads as no front: a front only
 * moves a step ahead, so reading none at worst leaves the line in its usual order.
 */
export class LineFrontStore {
  private readonly files: Files;
  private readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<LineFront | undefined> {
    const text = await this.files.read(this.path);
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    return isLineFront(parsed) ? parsed : undefined;
  }

  /** Puts `front` at the front, replacing the one there. */
  async put(front: LineFront): Promise<void> {
    await this.files.write(this.path, `${JSON.stringify(front)}\n`);
  }

  /** Takes the front off: true when one was there. */
  async clear(): Promise<boolean> {
    return this.files.remove(this.path);
  }
}
