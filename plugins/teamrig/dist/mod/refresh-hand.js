/**
 * The tab's side of the refresh within a long turn. The Stop hook asks for the handover only at a turn's end, so
 * a turn that runs past the threshold reached Claude Code's compaction first. The plugin's mod
 * (`hooks/register.ts`) runs a `RefreshHand` in every interactive tab:
 *
 * - after each tool result of the main conversation, once the context reached the size the CLI named, the hand
 *   asks the CLI (`hook refresh-mid`); an ask it answers with is added after the tool's result, which the model
 *   reads and the person does not see (src/refresh/decide.ts `decideMidTurn`);
 * - before Claude Code compacts the main conversation on its own, the hand asks the CLI (`hook compact-check`)
 *   and skips the compaction while the handover is asked for or written, up to `refresh.compactCeilingTokens`
 *   (`decideCompact`): the fresh start that follows the turn replaces it.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to a module
 * the mod imports as it is.
 */
/** How long one CLI run may take before it is stopped; the tool's result, or the compaction, waits for it. */
export const REFRESH_TIMEOUT_MS = 15_000;
/**
 * The least time between two asks while the CLI holds one past its size (background work the session started
 * still runs): the hand looks again at the first tool result after it.
 */
export const HOLD_GAP_MS = 60_000;
/** The longest the hand goes without asking the CLI while tools run, so a change of config is seen. */
export const RECHECK_MS = 10 * 60_000;
/** The command line that runs the plugin's CLI for one refresh command, given the plugin's folder. */
export function refreshCliArgv(pluginRoot, command) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', command];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isSize(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function recordOf(stdout) {
    try {
        const value = JSON.parse(stdout.trim());
        return isRecord(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** `hook refresh-mid`'s answer; undefined for anything else. */
export function parseMidTurnAnswer(stdout) {
    const value = recordOf(stdout);
    if (value === undefined) {
        return undefined;
    }
    const { kind, text, nextAt } = value;
    if (kind === 'ask' && typeof text === 'string' && isSize(nextAt)) {
        return { kind, text, nextAt };
    }
    if (kind === 'wait' && (nextAt === null || isSize(nextAt))) {
        return { kind, nextAt };
    }
    return undefined;
}
/** `hook compact-check`'s answer; undefined for anything else. */
export function parseCompactAnswer(stdout) {
    const value = recordOf(stdout);
    if (value === undefined) {
        return undefined;
    }
    const { kind, reason } = value;
    if (kind === 'skip' && typeof reason === 'string') {
        return { kind, reason };
    }
    return kind === 'go' ? { kind } : undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class RefreshHand {
    host;
    looking = false;
    /** The last answer, undefined to ask at the next tool result. */
    last;
    /** The context at the last tool result: one smaller means Claude Code compacted or cleared it since. */
    lastTokens;
    constructor(host) {
        this.host = host;
    }
    /** At a tool result of the main conversation, with the context the last reply read; never rejects. */
    async afterTool(tokens, window) {
        if (this.looking) {
            return { kind: 'overlap' };
        }
        if (this.lastTokens !== undefined && tokens < this.lastTokens) {
            // A /clear or a compaction: the refresh state the CLI named a size for may have started over.
            this.last = undefined;
        }
        this.lastTokens = tokens;
        const now = this.host.now();
        if (!this.isDue(now, tokens)) {
            return { kind: 'quiet' };
        }
        this.looking = true;
        try {
            return await this.look(now, tokens, window);
        }
        catch (error) {
            // Not asked again at every tool result while the CLI fails: only at the recheck.
            this.last = { at: now, nextAt: null, held: false };
            return { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.looking = false;
        }
    }
    /** Before Claude Code compacts the main conversation on its own; never rejects, and a failure lets it compact. */
    async beforeCompact(tokens, window) {
        try {
            const run = await this.run('compact-check', { tokens, window });
            const answer = run.exitCode === 0 ? parseCompactAnswer(run.stdout) : undefined;
            return answer ?? { kind: 'failed', error: `hook compact-check exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
        }
        catch (error) {
            return { kind: 'failed', error: messageOf(error) };
        }
    }
    async look(now, tokens, window) {
        const run = await this.run('refresh-mid', window === undefined ? { tokens } : { tokens, window });
        const answer = run.exitCode === 0 ? parseMidTurnAnswer(run.stdout) : undefined;
        if (answer === undefined) {
            throw new Error(`hook refresh-mid exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}`);
        }
        if (answer.kind === 'ask') {
            this.last = { at: now, nextAt: answer.nextAt, held: false };
            return { kind: 'asked', text: answer.text };
        }
        this.last = { at: now, nextAt: answer.nextAt, held: answer.nextAt !== null && tokens >= answer.nextAt };
        return { kind: 'waiting', nextAt: answer.nextAt };
    }
    async run(command, facts) {
        const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
        const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
        return this.host.cli(command, JSON.stringify({ session_id: sessionId, cwd, ...facts }), env, cwd);
    }
    /**
     * Ask the CLI at the first tool result and after a compaction or /clear, once the context reached the size it
     * named (a held ask only HOLD_GAP_MS after the last), and RECHECK_MS after the last ask.
     */
    isDue(now, tokens) {
        const { last } = this;
        if (last === undefined || now >= last.at + RECHECK_MS) {
            return true;
        }
        if (last.nextAt === null || tokens < last.nextAt) {
            return false;
        }
        return !last.held || now >= last.at + HOLD_GAP_MS;
    }
}
