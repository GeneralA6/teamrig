/**
 * How much of a transcript's end is read for its kind: its last turn's entries and any `continued` one after them
 * sit there, short of one tool result larger than this, which leaves the session judged as before.
 */
export const KIND_TAIL_BYTES = 1024 * 1024;
/**
 * The transcript's kind, read from its end through the host's `reader`: the last entry that says where it ran is the
 * last turn's, and only the few lines after it (titles, modes, snapshots) are read on the way. A torn first line of
 * a tail is unread and skipped.
 */
export function transcriptKindOf(reader, text) {
    const lines = text.split('\n');
    let continuedIn;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = reader.entry(lines[index] ?? '');
        if (entry === undefined || entry.kind === 'unread') {
            continue;
        }
        if (entry.kind === 'continued') {
            continuedIn ??= entry.into;
            continue;
        }
        if (entry.job !== undefined) {
            return { background: entry.job, continuedIn };
        }
    }
    return { background: false, continuedIn };
}
