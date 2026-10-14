import { errorCode } from './guards.ts';
import type { Sleep } from './lock.ts';

/**
 * The codes Windows returns while another process (an editor, a virus scanner, a reader mid-read)
 * holds a file open; each clears within moments, so the operation is worth repeating.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** About 1 s in all: short waits first, as most holds clear at once. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80, 120, 160, 160, 160, 160];

/**
 * Runs a file operation, repeating it after each delay while it fails with a transient code. Any
 * other error, or a transient one after the last delay, is thrown as it came.
 */
export async function retryTransient<T>(operation: () => Promise<T>, sleep: Sleep, delays: readonly number[] = TRANSIENT_RETRY_DELAYS_MS): Promise<T> {
  for (const delay of delays) {
    try {
      return await operation();
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !TRANSIENT_CODES.has(code)) {
        throw error;
      }
    }
    await sleep(delay);
  }
  return operation();
}
