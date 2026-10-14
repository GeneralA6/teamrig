/**
 * Exit codes: 0 done, 1 failed, 2 refused by a team rule, 3 `teamrig open` found no terminal to open and
 * printed the command to run instead, 64 a command line it cannot read.
 */
export const EXIT = { ok: 0, failed: 1, refused: 2, printed: 3, usage: 64 };
/** A request the team's rules or state refuse: printed as `REFUSED <reason>`, exit 2. */
export class RefusedError extends Error {
    name = 'RefusedError';
}
