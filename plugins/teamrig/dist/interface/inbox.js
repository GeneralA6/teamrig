import { ServedText } from "./text.js";
/**
 * A stored line as `inboxLineOf` (src/inbox/inbox.ts) writes it: `- YYYY-MM-DD HH:MM <from>: <text>`, the minute in
 * UTC. The sender is an id, or `<team>/<id>` from another team of the tree; a line may have none.
 */
const LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?: ([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?):)?(?: (.*))?$/;
/** A line's date, sender and words. A line with no date, or one no calendar holds, is all words. */
function parsedLine(line) {
    const [, day, minute, from, text] = LINE.exec(line) ?? [];
    const at = `${day}T${minute}:00.000Z`;
    if (day === undefined || minute === undefined || Number.isNaN(Date.parse(at))) {
        return { at: null, from: null, text: line };
    }
    return { at, from: from ?? null, text: text ?? '' };
}
/** The key of a line that is served with its words: its fingerprint, numbered from the second copy on. */
function fingerprintOf(hash, copy) {
    return copy === 1 ? hash : `${hash}-${copy}`;
}
/**
 * The `inbox` document's body: every unread line, and the read ones posted since `readSince`, in file order. It
 * makes its own `ServedText`, so `cuts` lists this document's cuts and no other's; a line left out is never scanned.
 */
export function inboxBody(input) {
    const served = new ServedText(input.shapes);
    const firstUnread = input.unread === null ? 0 : input.lines.length - input.unread;
    const copies = new Map();
    const lines = [];
    input.lines.forEach((line, index) => {
        // Counted over the whole file, not the served lines, so a key does not change as the window moves.
        const copy = (copies.get(line) ?? 0) + 1;
        copies.set(line, copy);
        const unread = index >= firstUnread;
        const parsed = parsedLine(line);
        if (unread || (parsed.at !== null && Date.parse(parsed.at) >= input.readSince)) {
            const key = served.wouldCut(parsed.text) ? `cut-${index + 1}` : fingerprintOf(input.keyOf(line), copy);
            const wrote = input.connectors.some((connector) => connector.id === parsed.from) ? 'outside' : 'team';
            lines.push({ key, at: parsed.at, from: parsed.from, text: served.marked(key, 'text', parsed.text, wrote), unread });
        }
    });
    const session = { id: input.session.id, name: served.plain(input.session.id, 'session.name', input.session.name) };
    return { session, unread: input.unread, lines, cuts: served.cuts };
}
