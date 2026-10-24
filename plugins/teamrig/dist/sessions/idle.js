import { isRecord, recordField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { MS_PER_MINUTE, parseDeadline } from "../core/time.js";
import { waitContext } from "../register/waits.js";
import { asksDecision, messageTextOf } from "../tabs/status.js";
import { replyOf } from "../turn-log/reply.js";
import { dayStartAt, startableTasks } from "../wake/day-start.js";
import { byUrgency, isNews, isWakeWorthy } from "../wake/decide.js";
/**
 * Whether an idle session closes and a closed one reopens, pure (T1100). One rule serves both: a session closes when
 * the wake check would not wake it (src/wake/decide.ts, src/wake/day-start.ts) and reopens when it would, so a closed
 * session comes back exactly when its open tab would get a prompt. A tab still in a turn, at a tool call or putting a
 * decision to the person stays open, and so does one whose own time wait ends soon.
 */
/** A session whose own time wait ends within this many minutes stays open: closing it would only reopen it. */
export const TIME_WAIT_GUARD_MINUTES = 30;
/** How the lines of a slash command open: Claude Code writes them as user entries, and they start no model turn. */
const LOCAL_COMMAND_TAGS = ['<command-name>', '<command-message>', '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>'];
/** How the entry Claude Code writes when the person stops a turn opens. */
const INTERRUPTED = '[Request interrupted by user';
function callsTool(entry) {
    const content = recordField(entry, 'message')?.['content'];
    return Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'tool_use');
}
/** True for an entry of the tab's own turns: the person's or the model's, not meta context, a helper's or a slash command's. */
function isTurnEntry(entry) {
    if (entry['isMeta'] === true || entry['isSidechain'] === true) {
        return false;
    }
    if (entry['type'] === 'assistant') {
        return true;
    }
    if (entry['type'] !== 'user') {
        return false;
    }
    const text = (messageTextOf(entry) ?? '').trimStart();
    return !LOCAL_COMMAND_TAGS.some((tag) => text.startsWith(tag));
}
/**
 * Where the tab's last turn stands, from its transcript's tail (`cut`: the tail of a longer file, whose first line may
 * be partial and is skipped). Its last own entry decides: a model entry calling a tool is at a call (running, or
 * waiting on a permission or an answer), a model reply that puts a decision to the person (`asksDecision`) asks one,
 * any other reply ended the turn; a person's entry (a prompt or a tool's result) is a turn under way, unless it is
 * the person stopping the turn. No entry: idle.
 */
export function tabActivityOf(text, cut) {
    const lines = text.split('\n').slice(cut ? 1 : 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseObject((lines[index] ?? '').trim());
        if (entry === undefined || !isTurnEntry(entry)) {
            continue;
        }
        if (entry['type'] === 'user') {
            return (messageTextOf(entry) ?? '').startsWith(INTERRUPTED) ? 'idle' : 'turn';
        }
        if (callsTool(entry)) {
            return 'call';
        }
        // Up to this reply only: a slash command run after it starts no turn, so the decision still waits.
        return asksDecision(replyOf(lines.slice(0, index + 1).join('\n'), undefined, !cut)?.text) ? 'question' : 'idle';
    }
    return 'idle';
}
/**
 * The soonest time wait of the session's own unfinished tasks within `maxPriority` that ends after `now` and within
 * `TIME_WAIT_GUARD_MINUTES`; undefined when none does.
 */
export function soonTimeWaitOf(tasks, session, maxPriority, now, zone) {
    const until = now + TIME_WAIT_GUARD_MINUTES * MS_PER_MINUTE;
    let soonest;
    for (const task of tasks.values()) {
        if (task.owner !== session || task.priority > maxPriority || task.status === 'done' || task.status === 'dropped') {
            continue;
        }
        for (const reason of task.waits) {
            const at = reason.kind === 'time' ? parseDeadline(reason.at, zone)?.getTime() : undefined;
            if (at !== undefined && at > now && at <= until && (soonest === undefined || at < soonest.at)) {
                soonest = { task, at };
            }
        }
    }
    return soonest;
}
/**
 * Whether a session teamrig closed reopens now, as the wake check would wake its open tab: for urgent lines posted to
 * it, whatever its rest and at once (each is urgent by its sender's choice, and a pass's closes post theirs together),
 * else for work it can start within `maxPriority` that someone else or the clock changed since it last touched it
 * (`isNews`, so work it saw before the close does not reopen it), else for a day start after its close when it has any
 * work it can start and does not rest (quiet hours, held by its budget). Else it stays closed.
 */
export function reopenVerdict(input) {
    const { tasks, session, now, zone } = input;
    if (input.asks.length > 0) {
        return { kind: 'asked', asks: input.asks, at: Math.min(...input.asks.map((ask) => ask.at)) };
    }
    const context = waitContext(tasks, new Date(now), zone);
    const handed = [...tasks.values()].filter((task) => isWakeWorthy(task, session, input.maxPriority, context) && isNews(task, session, tasks, zone)).sort(byUrgency);
    if (handed.length > 0) {
        return { kind: 'handed', tasks: handed };
    }
    const dayStart = input.dayStartUtc === undefined ? undefined : dayStartAt(input.dayStartUtc, now);
    if (dayStart === undefined || dayStart <= input.closedAt || input.rest.quiet || input.rest.held) {
        return { kind: 'stay' };
    }
    const startable = startableTasks(tasks, session, now, zone);
    return startable.length === 0 ? { kind: 'stay' } : { kind: 'day-start', at: dayStart, tasks: startable };
}
