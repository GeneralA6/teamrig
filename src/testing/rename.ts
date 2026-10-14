import { RENAME_VERSION, type Rename } from '../names/rename.ts';

/** A rename record, recorded by the session itself at a fixed time unless `extra` says otherwise. */
export function renameOf(id: string, from: string, to: string, extra: Partial<Rename> = {}): Rename {
  return { v: RENAME_VERSION, id, from, to, at: '2030-01-08T09:00:00.000Z', by: id, ...extra };
}
