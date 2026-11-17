import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isLineFront, LINE_FRONT_FILE, type LineFront } from './line-front.ts';

/** The path of the front file in the team's state folder `state`. */
export function lineFrontPath(state: string): string {
  return join(state, LINE_FRONT_FILE);
}

/**
 * The team's front file (T4082). A file that does not parse (one being replaced, a hand edit) reads as no front: a
 * front only moves a step ahead, so reading none at worst leaves the line in its usual order.
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
