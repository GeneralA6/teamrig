import { join } from 'node:path';
import { isNonNegativeInteger, isRecord } from '../core/guards.ts';
import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';

/**
 * A session's tab just opened and still loading: the MB it was counted to take from free memory (`needMb`) and to add
 * to the commit charge (`needCommittedMb`), held for it until it has loaded (`expiresAt`), since the host's free memory
 * does not show it yet. Stored host-wide, so every team's tab opens and queued steps count it.
 */
export interface TabHold {
  readonly id: string;
  readonly team: string;
  readonly session: string;
  readonly needMb: number;
  readonly needCommittedMb: number;
  /** An ISO time. */
  readonly openedAt: string;
  /** An ISO time; from it on, the tab counts as loaded and its hold is removed. */
  readonly expiresAt: string;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isTabHold(value: unknown): value is TabHold {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['team'] === 'string' &&
    typeof value['session'] === 'string' &&
    isNonNegativeInteger(value['needMb']) &&
    isNonNegativeInteger(value['needCommittedMb']) &&
    isTime(value['openedAt']) &&
    isTime(value['expiresAt'])
  );
}

function parseHold(text: string): TabHold | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isTabHold(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A hold's name, its id's; a writer's temporary sibling (`<name>.<pid>.<n>.tmp`) does not match. */
const HOLD_NAME = /^[^/\\]+\.json$/;

/** The folder of the tab holds beside the host lock at `hostLock`. */
export function tabHoldsDir(hostLock: string): string {
  return `${hostLock}.tabs`;
}

export interface TabHoldsPorts {
  readonly files: Files;
  readonly clock: Clock;
}

/** The tab holds in `dir`, one file per hold (`<id>.json`), each written whole. */
export class TabHolds {
  private readonly dir: string;
  private readonly ports: TabHoldsPorts;

  constructor(dir: string, ports: TabHoldsPorts) {
    this.dir = dir;
    this.ports = ports;
  }

  /**
   * The holds still live, oldest first. One that ran out or cannot be read (a hold is written whole, so it is damaged)
   * is removed as it is found.
   */
  async live(): Promise<TabHold[]> {
    const { files, clock } = this.ports;
    const found: TabHold[] = [];
    for (const name of (await files.list(this.dir)).filter((entry) => HOLD_NAME.test(entry))) {
      const path = join(this.dir, name);
      const text = await files.read(path);
      if (text === undefined) {
        continue;
      }
      const hold = parseHold(text);
      if (hold === undefined || Date.parse(hold.expiresAt) <= clock.now()) {
        await files.remove(path);
      } else {
        found.push(hold);
      }
    }
    return found.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  }

  async add(hold: TabHold): Promise<void> {
    await this.ports.files.write(this.pathOf(hold.id), JSON.stringify(hold));
  }

  /** Removes the hold `id`, for a tab whose open failed; nothing when it is gone already. */
  async remove(id: string): Promise<void> {
    await this.ports.files.remove(this.pathOf(id));
  }

  private pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
