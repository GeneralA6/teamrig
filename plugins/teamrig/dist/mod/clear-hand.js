/**
 * The tab's side of a refresh by /clear. The hidden restart runner (`refresh/restart.ts`) stays the brain:
 * once the session has been quiet for the whole delay it writes an ask for the tab's Claude Code session.
 * The plugin's mod (`hooks/register.ts`) runs a `ClearHand` in every interactive tab. The hand looks for
 * that ask each tick. While a turn runs it leaves the ask (`busy`). Otherwise it asks Claude Code for the
 * session's agents (`$.agent.list()`): while one is live (any status but completed, failed or killed, an
 * idle teammate included), or when the list fails, it answers `held` through the CLI (`hook clear-claim
 * --hold --why <reason>`) and runs no /clear, so the runner waits and asks again instead of ending the
 * process, which would take the helper with it; the runner names the last reason if it gives up. Else it
 * claims the ask through the CLI (`hook clear-claim`; both check that the restart is still pending) and on
 * a claim runs /clear the way the person would. Claude Code then
 * runs the SessionStart `clear` hooks that read the handover and wake the session. An ask in `end` mode
 * (the session must start again at a changed effort level, which a /clear keeps) goes through the same holds,
 * then is claimed with `hook clear-claim --end`; on `end` the hand runs no /clear and the runner ends the
 * session and starts it again in its tab.
 *
 * The hand also holds the /clear for the person (the ask's `PersonHold`, from the team's config): while the
 * prompt holds an unsent draft, within `afterActivityMs` of the person's last key or prompt in the tab, and
 * for HOLD_BUTTON_MS after they press "Hold" on the band above the prompt. Then it counts down
 * `countdownMs` on that band, holding each ask until the count ends, so the person sees the /clear coming;
 * "Refresh now" ends the count and every hold of theirs but a draft. The hand answers each ask at once: the
 * runner ends a tab that leaves an ask unanswered, so a hold is an answer, and the runner asks again after
 * its quiet delay. The band shows through every hold, not only the count: what holds the /clear and, for the
 * person's own holds, how long they have left, so the person never waits on a count that does not start.
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
/** What `hook clear-claim --hold` prints when this tab held the ask: a helper, a draft, the person or the band's count holds the /clear. */
export const CLAIM_HELD = 'held';
/** What the runner writes when it takes its ask back unclaimed. */
export const CLAIM_WITHDRAWN = 'withdrawn';
/** What `hook clear-claim --end` prints when this tab claimed an end ask: the runner ends the session, the hand runs no /clear. */
export const CLAIM_END = 'end';
/** The switch that makes `hook clear-claim` hold the ask instead of claiming it. */
export const HOLD_SWITCH = 'hold';
/** The switch with which the hand claims an ask in `end` mode, so an older hand, which never passes it, cannot take one by it. */
export const END_SWITCH = 'end';
/** The flag that gives a hold the hand's reason, which the restart names when it gives up. */
export const WHY_FLAG = 'why';
/** The hold of an ask that carries none (a restart older than the hold): the config's defaults, 20 s and 30 min. */
export const DEFAULT_PERSON_HOLD = { countdownMs: 20_000, afterActivityMs: 30 * 60_000 };
/** How long the band's "Hold" button holds the /clear. */
export const HOLD_BUTTON_MS = 10 * 60_000;
/**
 * How often the restart asks while the hand holds, for an ask that does not say (`askEveryMs`, which a restart
 * older than it leaves out): `refresh.restartDelaySeconds`' default, 15 s.
 */
export const DEFAULT_ASK_EVERY_MS = 15_000;
/**
 * How late the restart's next ask may come past its quiet delay (its process lookup and file reads). The band
 * stays that long past the delay after the last ask the hand held, and no longer: a restart that ended or gave
 * up meanwhile sends none, and the band must not stay.
 */
export const ASK_LATE_MS = 45_000;
/** A wait as the band reads it: whole minutes, rounded up, from a minute on; seconds below it. */
function waitText(secondsLeft) {
    return secondsLeft >= 60 ? `${Math.ceil(secondsLeft / 60)} min` : `${secondsLeft} s`;
}
/** The band's line above the prompt for what it shows. */
export function bandLine(view) {
    switch (view.kind) {
        case 'counting':
            return `teamrig: this session refreshes in ${view.secondsLeft} s, a fresh start from its handover`;
        case 'refreshing':
            return 'teamrig: this session is refreshing, a fresh start from its handover';
        case 'waiting': {
            const who = view.by === 'button' ? 'you pressed Hold' : 'you were active in this tab';
            return `teamrig: this session refreshes from its handover; ${who}, so it waits ${waitText(view.secondsLeft)} more`;
        }
        case 'held':
            return `teamrig: this session refreshes from its handover once nothing holds it: ${view.why}`;
    }
}
/**
 * Whether two views draw the same band (undefined: none): the same kind, whose buttons it draws, and the same
 * line, so the mod writes the band's value only when what it draws changes, not each second of a minute.
 */
export function sameBand(a, b) {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    return a.kind === b.kind && bandLine(a) === bandLine(b);
}
/** The statuses of an agent whose loop has ended (Claude Code's `AgentStatus`); every other one is live. */
const ENDED_AGENT_STATUSES = new Set(['completed', 'failed', 'killed']);
/**
 * The session's agents (`$.agent.list()`) that are live: pending, running, waiting, idle or any status
 * this file does not know, so a /clear never cuts off a helper or a teammate that may yet act.
 */
export function liveAgentsOf(agents) {
    return agents.filter((agent) => !ENDED_AGENT_STATUSES.has(agent.status));
}
/** A live agent as a hold's reason names it: its type, its status and its task, so a stale one shows which it is. */
function agentLineOf(agent) {
    return `${agent.type} ${agent.status} "${agent.description}"`;
}
/** A Claude Code session id as it may appear in a file name: letters, digits and dashes only. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
export function isClaudeSessionId(value) {
    return CLAUDE_SESSION_ID.test(value);
}
/** The ask for one Claude Code session in the ask folder; undefined for an id unsafe in a file name. */
export function askFileOf(dir, claudeSession) {
    return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.ask` : undefined;
}
/** How the ask was answered, `taken`, `held` or `withdrawn`, created once: the first writer wins and the other learns it lost. */
export function outcomeFileOf(dir, claudeSession) {
    return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.outcome` : undefined;
}
/**
 * Why the tab held the ask, written before its `held` outcome: the outcome stays the one word a restart
 * started under an older teamrig reads.
 */
export function holdWhyFileOf(dir, claudeSession) {
    return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.held` : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isDuration(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function holdOf(value) {
    if (!isRecord(value)) {
        return DEFAULT_PERSON_HOLD;
    }
    const { countdownMs, afterActivityMs } = value;
    return isDuration(countdownMs) && isDuration(afterActivityMs) ? { countdownMs, afterActivityMs } : DEFAULT_PERSON_HOLD;
}
/** An ask's mode: `end` only when it says so, so an ask a restart older than the mode posted stays a /clear. */
export function clearModeOf(value) {
    return value === 'end' ? 'end' : 'clear';
}
const DAMAGED_ASK = { request: undefined, hold: DEFAULT_PERSON_HOLD, askEveryMs: DEFAULT_ASK_EVERY_MS, mode: 'clear' };
/**
 * The ask file's request, hold, delay and mode; DEFAULT_PERSON_HOLD when it carries no hold or a damaged one,
 * DEFAULT_ASK_EVERY_MS when it carries no delay or a damaged one, `clear` when it names no `end` mode.
 */
export function parseHandAsk(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return DAMAGED_ASK;
    }
    if (!isRecord(value)) {
        return DAMAGED_ASK;
    }
    const { at, hold, askEveryMs, mode } = value;
    return {
        request: typeof at === 'string' ? at : undefined,
        hold: holdOf(hold),
        askEveryMs: isDuration(askEveryMs) ? askEveryMs : DEFAULT_ASK_EVERY_MS,
        mode: clearModeOf(mode),
    };
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Whether the CLI ran and printed `expected`, the one answer that lets the hand act. */
function answered(run, expected) {
    return run.exitCode === 0 && run.stdout.trim() === expected;
}
/** A CLI answer that was not the one asked for: its reason, or its exit code when it printed none. */
function declined(run) {
    const answer = run.stdout.trim();
    return { kind: 'declined', why: answer === '' ? `exit ${run.exitCode}` : answer };
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
    /** When the person last typed in the prompt box or sent a prompt. */
    lastActivity;
    /** Until when the band's "Hold" button holds the /clear. */
    holdUntil;
    /** When the person pressed "Refresh now": the next ask is claimed unless a draft or a helper holds it. */
    nowAskedAt;
    /** The band's count for one restart request, which ends at `endsAt`. */
    countdown;
    /** The last ask the hand held, which the band shows while the restart's next ask is not overdue. */
    lastHeld;
    constructor(host) {
        this.host = host;
    }
    /** A turn starts: the band hides, and the ask that comes after the turn starts a new count. */
    turnStarted() {
        this.busy = true;
        this.release();
    }
    turnEnded() {
        this.busy = false;
    }
    /** The person typed in the prompt box: the /clear waits `afterActivityMs` from now, which the band counts. */
    personActed() {
        this.lastActivity = this.host.now();
        this.countdown = undefined;
    }
    /**
     * The person sent a prompt, which cancels a pending restart (the UserPromptSubmit hook): the /clear waits
     * `afterActivityMs` from now, and the band hides until the restart asks again.
     */
    promptSent() {
        this.personActed();
        this.release();
    }
    /** The band's "Refresh now": the next ask is claimed, through every hold of the person's but a draft. */
    refreshNow() {
        this.nowAskedAt = this.host.now();
        this.holdUntil = undefined;
    }
    /** The band's "Hold": no /clear for HOLD_BUTTON_MS, which the band counts. */
    holdRefresh() {
        this.holdUntil = this.host.now() + HOLD_BUTTON_MS;
        this.endCount();
    }
    /**
     * What the band above the prompt shows now, from the last ask the hand held: undefined when it held none,
     * and once the restart's next ask is ASK_LATE_MS overdue (the restart ended or gave up).
     */
    band() {
        const now = this.host.now();
        const { lastHeld, countdown } = this;
        if (lastHeld === undefined || now - lastHeld.at >= lastHeld.ask.askEveryMs + ASK_LATE_MS) {
            return undefined;
        }
        if (lastHeld.named !== undefined) {
            return { kind: 'held', why: lastHeld.named };
        }
        if (this.nowAskedAt === undefined) {
            const wait = this.personWait(lastHeld.ask.hold);
            if (wait !== undefined) {
                return { kind: 'waiting', by: wait.by, secondsLeft: Math.ceil(wait.msLeft / 1000) };
            }
            if (countdown !== undefined && now < countdown.endsAt) {
                return { kind: 'counting', secondsLeft: Math.ceil((countdown.endsAt - now) / 1000) };
            }
        }
        // "Refresh now", or the count or the person's hold ended: the /clear, or its count, comes with the next ask.
        return { kind: 'refreshing' };
    }
    endCount() {
        this.countdown = undefined;
        this.nowAskedAt = undefined;
    }
    /** The restart's ask is over (claimed, no longer pending, cancelled or a turn ran): no band until the next ask is held. */
    release() {
        this.lastHeld = undefined;
        this.endCount();
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
            return { kind: 'failed', error: messageOf(error) };
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
        const stdin = JSON.stringify({ session_id: claudeSession });
        const handAsk = parseHandAsk(text);
        const held = await this.heldBy(handAsk);
        if (held !== undefined) {
            const hold = await this.host.cli(['hook', 'clear-claim', `--${HOLD_SWITCH}`, `--${WHY_FLAG}`, held.why], stdin);
            if (answered(hold, CLAIM_HELD)) {
                this.lastHeld = { at: this.host.now(), ask: handAsk, named: held.named };
                return { kind: 'held', why: held.why };
            }
            // The restart is no longer pending: no /clear follows this hold.
            this.release();
            return declined(hold);
        }
        const ending = handAsk.mode === 'end';
        const claim = await this.host.cli(ending ? ['hook', 'clear-claim', `--${END_SWITCH}`] : ['hook', 'clear-claim'], stdin);
        // Cleared, ending, or the restart is no longer pending: either way the count is over.
        this.release();
        if (!answered(claim, ending ? CLAIM_END : CLAIM_TAKEN)) {
            return declined(claim);
        }
        if (ending) {
            // A /clear here would keep the level the session must leave; the runner ends it instead.
            return { kind: 'ending' };
        }
        await this.host.clear();
        return { kind: 'cleared' };
    }
    /**
     * Why the hand holds this ask, in order: a live helper; an unsent draft; then, unless the person pressed
     * "Refresh now", their "Hold", their activity in the tab and the band's count. Undefined: claim it.
     */
    async heldBy(ask) {
        const named = (await this.helperHold()) ?? (await this.draftHold());
        if (named !== undefined) {
            this.endCount();
            return { why: named, named };
        }
        if (this.nowAskedAt !== undefined) {
            return undefined;
        }
        const person = this.personHold(ask.hold);
        if (person !== undefined) {
            this.countdown = undefined;
            return { why: person, named: undefined };
        }
        const count = this.countHold(ask);
        return count === undefined ? undefined : { why: count, named: undefined };
    }
    /** Why a /clear would cut off a helper now, or undefined when the session runs none: a list that fails counts as one. */
    async helperHold() {
        try {
            const live = await this.host.liveAgents();
            if (live.length === 0) {
                return undefined;
            }
            return `${live.length} ${live.length === 1 ? 'agent' : 'agents'} of this session still live: ${live.map(agentLineOf).join('; ')}`;
        }
        catch (error) {
            return `Claude Code would not list this session's agents: ${messageOf(error)}`;
        }
    }
    /** Why a /clear would land under the person's draft, or undefined when the prompt box is empty: a read that fails counts as one. */
    async draftHold() {
        try {
            return (await this.host.draft()).trim() === '' ? undefined : 'the prompt box holds an unsent draft';
        }
        catch (error) {
            return `Claude Code would not read the prompt box: ${messageOf(error)}`;
        }
    }
    /** The person's hold now and the ms it has left: their "Hold", else their last key or prompt within `afterActivityMs`. */
    personWait(hold) {
        const now = this.host.now();
        if (this.holdUntil !== undefined && now < this.holdUntil) {
            return { by: 'button', msLeft: this.holdUntil - now };
        }
        if (this.lastActivity !== undefined && now - this.lastActivity < hold.afterActivityMs) {
            return { by: 'activity', msLeft: this.lastActivity + hold.afterActivityMs - now };
        }
        return undefined;
    }
    /** Why the person holds the /clear now, for the restart. */
    personHold(hold) {
        const wait = this.personWait(hold);
        if (wait === undefined) {
            return undefined;
        }
        return wait.by === 'button'
            ? `the person pressed Hold: ${Math.ceil(wait.msLeft / 60_000)} min left`
            : `the person was active in this tab ${Math.floor((hold.afterActivityMs - wait.msLeft) / 1000)} s ago`;
    }
    /** Starts the band's count at a request's first ask that passed every other hold, and holds until it ends. */
    countHold(ask) {
        if (ask.hold.countdownMs === 0) {
            return undefined;
        }
        const now = this.host.now();
        if (this.countdown === undefined || this.countdown.request !== ask.request) {
            this.countdown = { request: ask.request, endsAt: now + ask.hold.countdownMs };
        }
        const left = this.countdown.endsAt - now;
        return left > 0 ? `the band counts down: ${Math.ceil(left / 1000)} s left` : undefined;
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
