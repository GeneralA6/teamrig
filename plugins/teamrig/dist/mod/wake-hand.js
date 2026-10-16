/**
 * The tab's side of waking an idle session when work is handed to it. An idle session sees new work only at its
 * next prompt, so the plugin's mod (`hooks/register.ts`) runs a `WakeHand` in every interactive tab. Every
 * WAKE_TICK_MS while no turn runs, the hand asks the CLI (`hook wake-check`) when the register file changed, when
 * the time the CLI named falls due (a batch of handed tasks), or RECHECK_MS after its last ask. The CLI decides,
 * under the session's own lock, and logs each wake with its cost (src/wake/decide.ts); the hand submits the prompt
 * it answers with `$.prompt.submit`, Claude Code's own call for a prompt, which starts a turn under the plugin's
 * name once the session is idle, and shows the cost in a toast. Nothing is typed into the terminal: the prompt box
 * and any draft in it stay as they were. A wake a prompt hook drops is logged through `hook wake-dropped`.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to a module
 * the mod imports as it is.
 */
/** How often the hand looks, while no turn runs; a look runs the CLI only when something may have changed. */
export const WAKE_TICK_MS = 15_000;
/** The longest the hand goes without asking the CLI, so a change of config or of the budget's quiet hours is seen. */
export const RECHECK_MS = 10 * 60_000;
/** How long one CLI run may take before it is stopped. */
export const WAKE_TIMEOUT_MS = 30_000;
/** The command line that runs the plugin's CLI for one wake command, given the plugin's folder. */
export function wakeCliArgv(pluginRoot, command) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', command];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTextList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
/** The CLI's answer; undefined for anything else. */
export function parseWakeAnswer(stdout) {
    let value;
    try {
        value = JSON.parse(stdout.trim());
    }
    catch {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }
    const { kind, ids, text, toast, watch, recheckAt, why } = value;
    if (kind === 'wake' && isTextList(ids) && typeof text === 'string' && typeof toast === 'string') {
        return { kind, ids, text, toast };
    }
    if (kind === 'wait' && typeof watch === 'string' && (recheckAt === null || (typeof recheckAt === 'number' && Number.isFinite(recheckAt)))) {
        return { kind, watch, recheckAt };
    }
    if (kind === 'off' && typeof why === 'string') {
        return { kind, why };
    }
    return undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class WakeHand {
    host;
    /** The turns running now, the main loop's and subagents' alike, by turn id. */
    turns = new Set();
    checking = false;
    /** The register file the CLI named, and when it had changed at the last ask (undefined: ask at the next tick). */
    watch;
    seenChange;
    /** When the last ask ran, and when the CLI asked to be asked again. */
    lastAsk;
    recheckAt;
    constructor(host) {
        this.host = host;
    }
    turnStarted(turnId) {
        this.turns.add(turnId);
    }
    turnEnded(turnId) {
        this.turns.delete(turnId);
    }
    /** One look; never rejects. */
    async tick() {
        if (this.checking) {
            return { kind: 'overlap' };
        }
        if (this.turns.size > 0) {
            return { kind: 'busy' };
        }
        this.checking = true;
        try {
            return await this.step();
        }
        catch (error) {
            return { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.checking = false;
        }
    }
    async step() {
        const now = this.host.now();
        const changed = this.watch === undefined ? undefined : await this.host.changedAt(this.watch);
        if (!this.isDue(now, changed)) {
            return { kind: 'quiet' };
        }
        // Taken before the ask, so a change made while it runs is seen at the next tick.
        this.seenChange = changed;
        this.lastAsk = now;
        this.recheckAt = undefined;
        const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
        const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
        const run = await this.host.cli('wake-check', JSON.stringify({ session_id: sessionId, cwd }), env, cwd);
        const answer = run.exitCode === 0 ? parseWakeAnswer(run.stdout) : undefined;
        if (answer === undefined) {
            return { kind: 'failed', error: `hook wake-check exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
        }
        if (answer.kind === 'off') {
            return answer;
        }
        if (answer.kind === 'wait') {
            if (answer.watch !== this.watch) {
                // A file first named now: ask once more at the next tick, which takes its change time first.
                this.watch = answer.watch;
                this.seenChange = undefined;
                this.lastAsk = undefined;
            }
            this.recheckAt = answer.recheckAt ?? undefined;
            return { kind: 'waiting', recheckAt: answer.recheckAt };
        }
        if (this.watch === undefined) {
            // Woken before the CLI named its file (a reload kept the tab's state): ask again at the next idle look.
            this.lastAsk = undefined;
        }
        const reason = await this.host.submit(answer.text);
        if (reason !== undefined) {
            await this.host.cli('wake-dropped', JSON.stringify({ session_id: sessionId, cwd, reason }), env, cwd);
            return { kind: 'dropped', ids: answer.ids, reason };
        }
        this.host.toast(answer.toast);
        return { kind: 'woke', ids: answer.ids };
    }
    /** Ask the CLI at the first look, when the register changed, when the CLI's time fell due, or RECHECK_MS on. */
    isDue(now, changed) {
        if (this.lastAsk === undefined || changed !== this.seenChange) {
            return true;
        }
        return (this.recheckAt !== undefined && now >= this.recheckAt) || now >= this.lastAsk + RECHECK_MS;
    }
}
