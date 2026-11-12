/**
 * The tab's side of a scheduled meeting's notification (T1358). Nothing runs at a meeting's time unless something
 * looks, so the plugin's mod (`hooks/register.ts`) runs a `MeetingHand` in every interactive tab. Every
 * MEETING_TICK_MS, a turn running or not, the hand asks the CLI (`hook meeting-due`) when the meetings file the CLI
 * named changed, when the time the CLI named came, or MEETING_RECHECK_MS after its last ask. The CLI marks each
 * meeting's notice stage due (before, at the slot, missed; T2405) as sent under the meetings lock, so one tab of the
 * team sends it, and starts its OS notification; the hand shows each notice it sent in the tab as a toast as well, a
 * missed one staying the longest the engine shows a toast. Nothing is typed into the terminal.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time but look-schedule.ts.
 */
import { LookSchedule } from "./look-schedule.js";
/** How often the hand looks; a look runs the CLI only when something may have changed. */
export const MEETING_TICK_MS = 30_000;
/** The longest the hand goes without asking the CLI, so a change the file does not show (a tab now a team's) is seen. */
export const MEETING_RECHECK_MS = 10 * 60_000;
/** How long one CLI run may take before it is stopped. */
export const MEETING_TIMEOUT_MS = 30_000;
/** The longest Claude Code shows a toast: its `ui.toast` drops one whose timeoutMs is over this (the engine's host check). */
export const TOAST_MAX_MS = 60_000;
/** The command line that runs the plugin's CLI as `hook meeting-due`, given the plugin's folder. */
export function meetingCliArgv(pluginRoot) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', 'meeting-due'];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTextList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function noticeOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { id, title, text } = value;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof text !== 'string') {
        return undefined;
    }
    const stage = stageOf(value['stage']);
    const stayMs = stayOf(value['stayMs']);
    return stage === undefined || stayMs === undefined ? undefined : { id, stage, title, text, stayMs };
}
/** A notice's stage; a CLI older than the stages (T2405) sends none, and its only notice was the one at the slot. */
function stageOf(value) {
    if (value === undefined) {
        return 'start';
    }
    return typeof value === 'string' ? value : undefined;
}
/** How long a toast stays; an older CLI sends none, so the toast keeps Claude Code's default. */
function stayOf(value) {
    if (value === undefined || value === null) {
        return null;
    }
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function noticesOf(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const notices = value.flatMap((item) => {
        const notice = noticeOf(item);
        return notice === undefined ? [] : [notice];
    });
    return notices.length === value.length ? notices : undefined;
}
/** The CLI's answer; undefined for anything else. */
export function parseMeetingDueAnswer(stdout) {
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
    const { kind, watch, recheckAt, why } = value;
    const notices = noticesOf(value['notices']);
    if (kind === 'due' && notices !== undefined && isTextList(watch) && (recheckAt === null || (typeof recheckAt === 'number' && Number.isFinite(recheckAt)))) {
        return { kind, notices, watch, recheckAt };
    }
    if (kind === 'off' && typeof why === 'string') {
        return { kind, why };
    }
    return undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class MeetingHand {
    host;
    looks;
    checking = false;
    constructor(host) {
        this.host = host;
        this.looks = new LookSchedule(MEETING_RECHECK_MS, (path) => host.changedAt(path));
    }
    /** One look; never rejects. A running turn does not hold it: the owner hears of a meeting at its time. */
    async tick() {
        if (this.checking) {
            return { kind: 'overlap' };
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
        if (!(await this.looks.due(this.host.now()))) {
            return { kind: 'quiet' };
        }
        const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
        const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
        const run = await this.host.cli(JSON.stringify({ session_id: sessionId, cwd }), env, cwd);
        const answer = run.exitCode === 0 ? parseMeetingDueAnswer(run.stdout) : undefined;
        if (answer === undefined) {
            return { kind: 'failed', error: `hook meeting-due exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
        }
        if (answer.kind === 'off') {
            return answer;
        }
        this.looks.waitFor(answer.watch, answer.recheckAt);
        if (answer.notices.length === 0) {
            return { kind: 'waiting', recheckAt: answer.recheckAt };
        }
        for (const notice of answer.notices) {
            // A CLI asking a longer stay than the engine allows still gets its toast, for the longest the engine shows one.
            this.host.toast(`${notice.title}: ${notice.text}`, notice.stayMs === null ? null : Math.min(notice.stayMs, TOAST_MAX_MS));
        }
        return { kind: 'notified', ids: answer.notices.map((notice) => notice.id) };
    }
}
