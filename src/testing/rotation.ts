import { toJsonlLine } from '../core/jsonl.ts';
import { compactRegister, RETAIN_DAYS, type Compaction } from '../register/compaction.ts';
import { layoutPaths, readWorkingSet } from '../register/layout.ts';
import { markerRecord } from '../register/marker.ts';
import { readEvents } from '../register/snapshot.ts';
import type { MemoryFiles } from './memory-files.ts';

export interface RotateOptions {
  readonly now: Date;
  readonly retainDays?: number;
  readonly keep?: ReadonlySet<string>;
}

/**
 * Rotates a register held in `files` the way a rotation lays it out: the tail becomes the next
 * archive segment whole, a marker starts the new tail, and the snapshot is the compaction of the
 * working set as it stood. For tests of the readers, which must read every layout a rotation leaves.
 */
export async function rotateRegister(files: MemoryFiles, eventsPath: string, options: RotateOptions): Promise<Compaction> {
  const paths = layoutPaths(eventsPath);
  const text = files.get(paths.tail) ?? '';
  const covered = readEvents(text).rotatedAfter + 1;
  const source = await readWorkingSet(files, paths);
  await files.write(paths.segment(covered), text);
  await files.write(paths.tail, toJsonlLine(markerRecord(covered, options.now.toISOString())));
  const compaction = compactRegister(source, {
    covered,
    now: options.now,
    retainDays: options.retainDays ?? RETAIN_DAYS,
    keep: options.keep ?? new Set(),
  });
  await files.write(paths.snapshot, compaction.text);
  return compaction;
}
