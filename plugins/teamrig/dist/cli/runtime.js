/**
 * Exit codes: 0 done, 1 failed, 2 refused by a team rule, 3 `teamrig open` found no terminal to open and
 * printed the command to run instead, 4 `/teamrig` printed the line the person must agree to before it runs
 * (`hook slash-command`, src/mod/slash-hand.ts asks), 64 a command line it cannot read.
 */
/** `wake` is a background hook's exit 2: with `asyncRewake`, Claude Code gives the model what it printed to stderr as a new turn. */
export const EXIT = { ok: 0, failed: 1, refused: 2, wake: 2, printed: 3, ask: 4, usage: 64 };
/** A request the team's rules or state refuse: printed as `REFUSED <reason>`, exit 2. */
export class RefusedError extends Error {
    name = 'RefusedError';
}
