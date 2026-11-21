import { stringField } from "../core/guards.js";
import { hostSessionOf } from "../core/host-session.js";
import { parseJsonl, toJsonlLine } from "../core/jsonl.js";
export const HINT_VERSION = 1;
/**
 * `bind-hints.jsonl`: one `{"v":1,"claudeSession":"…","reason":"…","at":"…"}` line per hint given. A later
 * teamrig's line names the tab `hostSession`, and its hint counts here too: both share the log until every tab
 * has reloaded.
 */
export class JsonlHintLog {
    log;
    constructor(log) {
        this.log = log;
    }
    /** A line of any version naming the session and reason counts: a newer teamrig gave that hint too. */
    async shown(claudeSession, reason) {
        const { records } = parseJsonl((await this.log.read()) ?? '');
        return records.some((line) => hostSessionOf(line.record, 'claudeSession') === claudeSession && stringField(line.record, 'reason') === reason);
    }
    async record(claudeSession, reason, at) {
        await this.log.append(toJsonlLine({ v: HINT_VERSION, claudeSession, reason, at: at.toISOString() }));
    }
}
/**
 * Whether the hint prints now: the first time for this Claude Code session and reason, recorded
 * before it prints. A log that cannot be read or written never silences the hint: it prints again.
 */
export async function firstHint(log, claudeSession, reason, now) {
    try {
        if (await log.shown(claudeSession, reason)) {
            return false;
        }
        await log.record(claudeSession, reason, now);
    }
    catch {
        // The hint is one short line: shown again beats never shown.
    }
    return true;
}
