import { isEffortLevel } from "../config/types.js";
const COMMAND_MARK = '<command-name>/effort</command-name>';
const REPLY_MARK = '<local-command-stdout>Set effort level to ';
const REPLY_LEVEL = /^<local-command-stdout>Set effort level to ([a-z]+)\b/;
/**
 * The line as text the user typed in this session's main thread, else undefined: a helper's, the host's own text
 * (a peer's message), one that names where it came from (a plugin's injected /clear, a peer), another session's,
 * and a tool result (whose content is a list of parts) are no typing of the user's. So is a torn line of a tail
 * read, which starts mid-line.
 */
function typedOf(reader, line, hostSession) {
    const entry = reader.entry(line, ['input']);
    if (entry?.kind !== 'input' || entry.thread !== 'main' || entry.meta || entry.origin !== undefined || entry.session !== hostSession) {
        return undefined;
    }
    return entry.text === undefined ? undefined : { text: entry.text, id: entry.id, at: entry.at, parent: entry.parent };
}
/**
 * Each `/effort` the user typed in the transcript text (whole or a tail), oldest first, with the level the host
 * says it set. Only lines that hold one of the two marks are read. A command with no reply, or a reply naming no
 * level teamrig knows (a cancelled picker, `auto`), is left out: nothing says what level runs after it.
 */
export function typedEffortsOf(reader, text, hostSession) {
    const commands = [];
    const replies = new Map();
    for (const line of text.split('\n')) {
        if (!line.includes(COMMAND_MARK) && !line.includes(REPLY_MARK)) {
            continue;
        }
        const typed = typedOf(reader, line, hostSession);
        if (typed === undefined) {
            continue;
        }
        if (typed.text.startsWith(COMMAND_MARK) && typed.id !== undefined && typed.at !== undefined) {
            commands.push({ uuid: typed.id, at: typed.at });
            continue;
        }
        const level = REPLY_LEVEL.exec(typed.text)?.[1];
        if (typed.parent !== undefined && isEffortLevel(level)) {
            replies.set(typed.parent, level);
        }
    }
    return commands.flatMap(({ uuid, at }) => {
        const level = replies.get(uuid);
        return level === undefined ? [] : [{ uuid, at, level }];
    });
}
