import { errorCode } from "./guards.js";
/**
 * The codes Windows returns while another process (an editor, a virus scanner, a reader mid-read)
 * holds a file open; each clears within moments, so the operation is worth repeating.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** About 1 s in all: short waits first, as most holds clear at once. */
export const TRANSIENT_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 120, 160, 160, 160, 160];
/**
 * About 10 s in all, for a rename that replaces a file. Windows refuses to replace a file while any process holds it
 * open, a Node reader that shares delete included, and a file every waiter polls (the host lock) is open again and
 * again: under load the holds chained past the 1 s above three times (T1704). graceful-fs waits up to 60 s for the
 * same reason. The short waits come first, as most holds still clear at once.
 */
export const REPLACE_RETRY_DELAYS_MS = [...TRANSIENT_RETRY_DELAYS_MS, ...Array.from({ length: 18 }, () => 500)];
/**
 * Runs a file operation, repeating it after each delay while it fails with a transient code. Any
 * other error, or a transient one after the last delay, is thrown as it came.
 */
export async function retryTransient(operation, sleep, delays = TRANSIENT_RETRY_DELAYS_MS) {
    for (const delay of delays) {
        try {
            return await operation();
        }
        catch (error) {
            const code = errorCode(error);
            if (code === undefined || !TRANSIENT_CODES.has(code)) {
                throw error;
            }
        }
        await sleep(delay);
    }
    return operation();
}
