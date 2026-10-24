import type { StoreFolders } from '../core/plugin-store.ts';

/** A path as the fake keys it: `\` and `/` one separator, so a test may spell its paths with `join`. */
function keyOf(path: string): string {
  return path.replaceAll('\\', '/');
}

/** A plugin store for tests: every path is missing and every folder empty until a test dates or fills it. */
export class FakePluginStore implements StoreFolders {
  private readonly changed = new Map<string, number>();
  private readonly folders = new Map<string, readonly string[]>();

  /** Dates a file or folder of the store: it changed at `at`, in milliseconds since the epoch. */
  date(path: string, at: number): this {
    this.changed.set(keyOf(path), at);
    return this;
  }

  /** The folders directly in `path`. */
  fill(path: string, folders: readonly string[]): this {
    this.folders.set(keyOf(path), folders);
    return this;
  }

  async changedAt(path: string): Promise<number | undefined> {
    return this.changed.get(keyOf(path));
  }

  async foldersIn(path: string): Promise<readonly string[]> {
    return this.folders.get(keyOf(path)) ?? [];
  }
}
