import { unreadOf } from "./unread.js";
export const INJECT_CAPS = { maxLines: 5, maxChars: 1500 };
/** The newest mark the hook left for `claudeSession` on `area`; null when it showed it none of the area's lines. */
export function newestShownOf(marks, area, claudeSession) {
    return claudeSession === null ? null : (marks.findLast((mark) => mark.area === area && mark.claudeSession === claudeSession) ?? null);
}
/**
 * The newest mark the hook left on `area` for any Claude Code session: how far the area's session saw its inbox at a
 * prompt, whichever incarnation of it (`inbox status` reads it, as no prompt is its own).
 */
export function lastShownOf(marks, area) {
    return marks.findLast((mark) => mark.area === area) ?? null;
}
/**
 * The unread lines the hook has not shown this Claude Code session: those after the read mark, or
 * after the shown mark when it is the later one. Both are tails of the same lines, so the shorter tail
 * starts later. A shown mark whose last line is gone (the file was rewritten) counts for nothing.
 */
export function unshownOf(area, lines, read, shown, hash) {
    const unread = unreadOf(area, lines, read, hash).lines;
    if (shown === null) {
        return unread;
    }
    const after = unreadOf(area, lines, shown, hash);
    return after.resume !== 'rewritten' && after.lines.length < unread.length ? after.lines : unread;
}
/** A line the hook had to cut to fit: it was not shown whole, so `inbox read` prints it again. */
export function cutWhenShown(line, caps = INJECT_CAPS) {
    return line.length > caps.maxChars;
}
