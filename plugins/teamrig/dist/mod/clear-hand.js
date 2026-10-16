/**
 * The tab's side of a refresh by /clear. The hidden restart runner (`refresh/restart.ts`) stays the brain:
 * once the session has been quiet for the whole delay it writes an ask for the tab's Claude Code session.
 * The plugin's mod (`hooks/register.ts`) runs a `ClearHand` in every interactive tab. The hand looks for
 * that ask each tick, claims it through the CLI (`hook clear-claim`, which also checks that the restart is
 * still pending), and on a claim runs /clear the way the person would. Claude Code then runs the
 * SessionStart `clear` hooks that read the handover and wake the session.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to
 * a module the mod imports as it is, and the CLI shares its file names from here.
 */
/** How often the mod's hand looks for an ask. */
export const TICK_MS = 1_000;
/** How long the hand waits before it asks the CLI for the ask folder again after that failed. */
export const DIR_RETRY_MS = 60_000;
/** What `hook clear-claim` prints when this tab took the ask; anything else is a reason it did not. */
export const CLAIM_TAKEN = 'taken';
/** What the runner writes when it takes its ask back unclaimed. */
export const CLAIM_WITHDRAWN = 'withdrawn';
/** A Claude Code session id as it may appear in a file name: letters, digits and dashes only. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
export function isClaudeSessionId(value) {
    return CLAUDE_SESSION_ID.test(value);
}
/** The ask for one Claude Code session in the ask folder; undefined for an id unsafe in a file name. */
export function askFileOf(dir, claudeSession) {
    return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.ask` : undefined;
}
/** Who won the ask, `taken` or `withdrawn`, created once: the first writer wins and the other learns it lost. */
export function outcomeFileOf(dir, claudeSession) {
    return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.outcome` : undefined;
}
export class ClearHand {
    host;
    dir;
    dirFailedAt;
    /** The text of the last ask the hand acted on, so it acts on each ask once. */
    seen;
    /** A turn runs: from turn.start to turn.complete. */
    busy = false;
    ticking = false;
    constructor(host) {
        this.host = host;
    }
    turnStarted() {
        this.busy = true;
    }
    turnEnded() {
        this.busy = false;
    }
    async tick() {
        if (this.ticking) {
            return { kind: 'overlap' };
        }
        this.ticking = true;
        try {
            return await this.step();
        }
        catch (error) {
            return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
        finally {
            this.ticking = false;
        }
    }
    async step() {
        const dir = await this.askDir();
        if (dir === undefined) {
            return { kind: 'no folder' };
        }
        const claudeSession = await this.host.sessionId();
        const ask = askFileOf(dir, claudeSession);
        if (ask === undefined || !(await this.host.exists(ask))) {
            return { kind: 'no ask' };
        }
        const text = await this.host.read(ask);
        if (text === this.seen) {
            return { kind: 'no ask' };
        }
        this.seen = text;
        if (this.busy) {
            return { kind: 'busy' };
        }
        const claim = await this.host.cli(['hook', 'clear-claim'], JSON.stringify({ session_id: claudeSession }));
        const answer = claim.stdout.trim();
        if (claim.exitCode !== 0 || answer !== CLAIM_TAKEN) {
            return { kind: 'declined', why: answer === '' ? `exit ${claim.exitCode}` : answer };
        }
        await this.host.clear();
        return { kind: 'cleared' };
    }
    /** The ask folder, asked of the CLI once (`hook clear-dir`), and again only DIR_RETRY_MS after a failure. */
    async askDir() {
        if (this.dir !== undefined) {
            return this.dir;
        }
        const now = this.host.now();
        if (this.dirFailedAt !== undefined && now - this.dirFailedAt < DIR_RETRY_MS) {
            return undefined;
        }
        const run = await this.host.cli(['hook', 'clear-dir'], '').catch(() => undefined);
        const dir = run?.exitCode === 0 ? run.stdout.trim() : '';
        if (dir === '') {
            this.dirFailedAt = now;
            return undefined;
        }
        this.dir = dir;
        return dir;
    }
}
