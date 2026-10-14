import { stat } from 'node:fs/promises';

export type PathKind = 'file' | 'folder' | 'none';

/** Whether a path is a file, a folder or nothing, without reading it: a program can be large. */
export interface PathProbe {
  kind(path: string): Promise<PathKind>;
}

/** The real filesystem, following links; anything it cannot stat counts as nothing. */
export const NODE_PATH_PROBE: PathProbe = {
  async kind(path) {
    try {
      const stats = await stat(path);
      return stats.isFile() ? 'file' : stats.isDirectory() ? 'folder' : 'none';
    } catch {
      return 'none';
    }
  },
};
