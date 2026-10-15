/** An inbox file's items, as every reader counts them: its non-empty lines, each without a CR line end. */
export function inboxLines(text) {
    return text
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.trim() !== '');
}
/** The lines of `area`'s inbox not yet read, after its newest mark (null when it has none). */
export function unreadOf(area, lines, mark, hash) {
    const from = resumeAt(lines, mark, hash);
    return { area, total: lines.length, lines: lines.slice(from.index), mark, resume: from.kind };
}
function resumeAt(lines, mark, hash) {
    if (mark === null) {
        return { index: 0, kind: 'never' };
    }
    if (mark.lastLineHash === null) {
        // A v0 mark knows only a count: trust it unless the file shrank below it.
        return mark.line > lines.length ? { index: 0, kind: 'rewritten' } : { index: mark.line, kind: 'grew' };
    }
    if (mark.line === 0) {
        return { index: 0, kind: 'grew' };
    }
    // Trimming the top shifts the last line read upwards, so search from the mark down to the top.
    for (let index = Math.min(mark.line, lines.length) - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line !== undefined && hash(line) === mark.lastLineHash) {
            return { index: index + 1, kind: index + 1 === mark.line ? 'grew' : 'moved' };
        }
    }
    return { index: 0, kind: 'rewritten' };
}
