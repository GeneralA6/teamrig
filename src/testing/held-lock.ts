import { KIT_VERSION } from '../core/version.ts';
import { FakeSessionProcesses } from './fake-session-processes.ts';

/** The pid of the step that holds the lock in {@link heldBy}. */
export const OTHER = 9001;

/** A host lock another step holds: taken at 09:50 by `OTHER`, lasting to `expiresAt`. */
export function heldBy(expiresAt: string = '2030-01-08T12:20:00.000Z'): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt });
}

/** `OTHER` runs, so its lock is live until it expires. */
export function otherRuns(): FakeSessionProcesses {
  return new FakeSessionProcesses().add({ pid: OTHER, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });
}
