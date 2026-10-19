import { toJsonlLine } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
import { compactRegister, RETAIN_DAYS, type Compaction } from '../register/compaction.ts';
import { layoutPaths, readWorkingSet } from '../register/layout.ts';
import { markerRecord } from '../register/marker.ts';
import { readEvents } from '../register/snapshot.ts';
import type { MemoryFiles } from './memory-files.ts';

export interface RotateOptions {
  readonly now: Date;
  /** The team's zone; UTC when left out. */
  readonly zone?: TimeZone;
  readonly retainDays?: number;
  readonly keep?: ReadonlySet<string>;
}

/**
 * Rotates a register held in `files` the way a rotation lays it out: the tail becomes the next
 * archive segment whole, a marker starts the new tail, and the snapshot is the compaction of the
 * working set as it stood. For tests of the readers, which must read every layout a rotation leaves.
 * It lays the files out without the writer's checks (register/rotate.ts), so it also builds layouts
 * the writer refuses to make but a reader still meets, such as a tail with lines from a newer teamrig;
 * rotate.test.ts holds the writer's files equal to these.
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
    zone: options.zone ?? TimeZone.UTC,
    retainDays: options.retainDays ?? RETAIN_DAYS,
    keep: options.keep ?? new Set(),
  });
  await files.write(paths.snapshot, compaction.text);
  return compaction;
}
