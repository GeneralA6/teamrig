import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';

/**
 * The `request` each ticket in the line of the host lock at `lockPath` says its step asks, in arrival order: undefined
 * for a ticket that names none. A spec reads it while a step waits, since the step removes its ticket when it ends.
 */
export async function lineRequests(files: Pick<Files, 'list' | 'read'>, lockPath: string): Promise<unknown[]> {
  const queue = `${lockPath}.queue`;
  const requests: unknown[] = [];
  for (const name of (await files.list(queue)).toSorted()) {
    const text = await files.read(join(queue, name));
    const ticket: unknown = text === undefined ? undefined : JSON.parse(text);
    requests.push(isRecord(ticket) ? ticket['request'] : undefined);
  }
  return requests;
}
