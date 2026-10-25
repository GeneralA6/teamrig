import { join } from 'node:path';
import { numberField, stringField } from "../core/guards.js";
import { KIT_NAME } from "../core/home.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { costText, idsText, wakePrompt, wakeToast } from "./decide.js";
/** The format of an ask's file; one in another format, or damaged, reads as no ask and goes at the next check. */
export const WAKE_ASK_FORMAT = 1;
export function formatWakeAsk(ask) {
    return toJsonlLine({ [VERSION_FIELD]: WAKE_ASK_FORMAT, from: ask.from, text: ask.text, at: ask.at });
}
/** An ask file's content; undefined when it is damaged or from another format. */
export function parseWakeAsk(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== WAKE_ASK_FORMAT) {
        return undefined;
    }
    const from = stringField(record, 'from');
    const line = stringField(record, 'text');
    const at = numberField(record, 'at');
    return from === undefined || line === undefined || at === undefined ? undefined : { from, text: line, at };
}
/** `<at>-<n>.json`: the post time, then a count that keeps two asks posted in one millisecond apart. */
const ASK_FILE = /^(\d+)-(\d+)\.json$/;
/** The most asks one session gets in one millisecond; past it a post fails rather than look on for a free name. */
export const ASKS_PER_MS = 100;
/** The post time and count of an ask file's name; undefined for any other file (a write's temporary sibling). */
function orderOf(name) {
    const match = ASK_FILE.exec(name);
    return match === null ? undefined : [Number(match[1]), Number(match[2])];
}
/** The folder that holds the session's asks, which an idle tab of the session watches (src/mod/wake-hand.ts). */
export function asksFolderOf(folder, id) {
    return join(folder, id);
}
/**
 * Each session's asks, one file each (`<id>/<at>-<n>.json`), created whole (`createExclusive`), so a check that
 * takes the asks it read never takes, nor loses, one posted meanwhile. Ids are session ids, checked by the roster, so
 * they are safe in a path.
 */
export class WakeAsks {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    async post(id, ask) {
        const text = formatWakeAsk(ask);
        for (let n = 0; n < ASKS_PER_MS; n += 1) {
            if (await this.files.createExclusive(join(asksFolderOf(this.folder, id), `${ask.at}-${n}.json`), text)) {
                return;
            }
        }
        throw new Error(`${id} already has ${ASKS_PER_MS} asks posted at ${new Date(ask.at).toISOString()}`);
    }
    /** The session's asks, oldest first. */
    async read(id) {
        const named = (await this.files.list(asksFolderOf(this.folder, id))).flatMap((name) => {
            const order = orderOf(name);
            return order === undefined ? [] : [{ name, order }];
        });
        named.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
        const stored = [];
        for (const { name } of named) {
            const text = await this.files.read(join(asksFolderOf(this.folder, id), name));
            if (text !== undefined) {
                stored.push({ name, ask: parseWakeAsk(text) });
            }
        }
        return stored;
    }
    /** Removes the asks read, and only those. */
    async remove(id, stored) {
        for (const { name } of stored) {
            await this.files.remove(join(asksFolderOf(this.folder, id), name));
        }
    }
}
/** The asks read, without the damaged ones and those from another format. */
export function validAsksOf(stored) {
    return stored.flatMap((each) => (each.ask === undefined ? [] : [each.ask]));
}
/** `an urgent line from <sender>`, or `<n> urgent lines from <senders>`, each sender once. */
export function urgentLinesText(asks) {
    const senders = [...new Set(asks.map((ask) => ask.from))].join(', ');
    return `${asks.length === 1 ? 'an urgent line' : `${asks.length} urgent lines`} from ${senders}`;
}
/**
 * The asks wake the session once the oldest is `batchMs` old (`wake.batchSeconds`), so the asks posted together (the
 * closes one idle pass starts at once) wake it once; the minimum gap between wakes does not hold them, since each is
 * urgent by its sender's choice.
 */
export function askVerdictOf(stored, now, batchMs) {
    const asks = validAsksOf(stored);
    if (asks.length === 0) {
        return { kind: 'none' };
    }
    const at = Math.min(...asks.map((ask) => ask.at)) + batchMs;
    return now < at ? { kind: 'later', at } : { kind: 'wake', asks };
}
/** `- HH:MM <sender>: <text>`, one line each, on the team's clock. */
function quotedLines(asks, zone) {
    return asks.map((ask) => `- ${zone.clock(new Date(ask.at))} ${ask.from}: ${ask.text}`).join('\n');
}
/** The wake's prompt: the asks quoted one a line, on the team's clock, then the work handed meanwhile, if any. */
export function handedPrompt(session, tasks, asks, cost, zone) {
    if (asks.length === 0) {
        return wakePrompt(session, tasks, cost);
    }
    const rest = tasks.length === 0 ? `This wake costs ${costText(cost)}.` : wakePrompt(session, tasks, cost);
    return `Urgent lines were posted for you while this tab was idle; act on each now:\n${quotedLines(asks, zone)}\n${rest}`;
}
/**
 * The first prompt of a session reopened with urgent lines posted while it was closed (T1100): the lines quoted on
 * the team's clock ahead of its own first prompt (`prompt`), so it acts on them first; when that is over `max`
 * characters, their count and senders instead, since each is also an inbox line.
 */
export function urgentFirstPrompt(asks, prompt, zone, max) {
    if (asks.length === 0) {
        return prompt;
    }
    const quoted = `Urgent lines were posted for you while you were closed; act on each first:\n${quotedLines(asks, zone)}\n${prompt}`;
    return quoted.length <= max ? quoted : `Posted for you while you were closed, in your inbox: ${urgentLinesText(asks)}; act on each first.\n${prompt}`;
}
/** The person's toast: which lines and tasks woke the tab and what it costs. */
export function handedToast(tasks, asks, cost) {
    if (asks.length === 0) {
        return wakeToast(tasks, cost);
    }
    const lines = urgentLinesText(asks);
    // The tasks first, so the senders' list ends the sentence and no id reads as a sender.
    const what = tasks.length === 0 ? lines : `${idsText(tasks)} and ${lines}`;
    return `${KIT_NAME} woke this tab for ${what} (${costText(cost)})`;
}
