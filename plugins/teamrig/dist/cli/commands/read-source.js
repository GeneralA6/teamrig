import { basename, isAbsolute, relative, sep } from 'node:path';
import { MissingSegmentError, readHistory, readWorkingSet } from "../../register/layout.js";
import { lacksEventsOf } from "../../register/snapshot.js";
/** `load`, run at the first call and answered from that one run after it. */
export function once(load) {
    let loaded;
    return () => (loaded ??= load());
}
/** Each path's stamp, in order; null for a file that is not there. */
export async function stampsOf(runtime, paths) {
    const stamps = [];
    for (const path of paths) {
        stamps.push((await runtime.files.stamp(path)) ?? null);
    }
    return stamps;
}
/**
 * How a problem names a file: from the team's folder down, as `app/state/events.jsonl`, with `/` on every OS. Its
 * place on the disk is never served: it holds the user's home. A file the config moved out of the team's folder
 * (`paths`) is named by its own name alone, which is teamrig's.
 */
export function servedPathOf(folder, path) {
    return [folder.team, ...(belowOf(folder, path) ?? ['(moved)', basename(path)])].join('/');
}
/** The folders and the file that lead from the team's folder down to `path`; undefined for a path not inside it. */
export function belowOf(folder, path) {
    const below = relative(folder.home, path);
    const inside = below !== '' && !below.startsWith('..') && !isAbsolute(below);
    return inside ? below.split(sep) : undefined;
}
/**
 * The lines of a log that were left out of its read, a line per kind. Every problem a document carries is such a
 * fixed text: a file's served name, a count and a kind, never a parser's own message, which quotes the damaged
 * line, and that line was never scanned for a secret.
 */
export function skippedOf(folder, path, read) {
    const name = servedPathOf(folder, path);
    return [
        ...(read.unreadable > 0 ? [`${name}: ${read.unreadable} unreadable line(s) left out`] : []),
        ...(read.newer > 0 ? [`${name}: ${read.newer} line(s) from a newer teamrig left out; update teamrig`] : []),
    ];
}
/**
 * The register's tasks and what could not be read of them. An archive with a segment gone serves no task and says
 * why, where a text command refuses: one broken document must not take down the others asked in the same run.
 */
export async function workingSetOf(runtime, folder, layout) {
    try {
        const snapshot = await readWorkingSet(runtime.files, layout);
        return { tasks: snapshot.state.tasks, problems: damageOf(snapshot, folder, layout.tail) };
    }
    catch (error) {
        if (error instanceof MissingSegmentError) {
            const segment = servedPathOf(folder, error.path);
            return { tasks: new Map(), problems: [`${segment}: missing, so the register's archive is incomplete and its tasks cannot be read`] };
        }
        throw error;
    }
}
/**
 * Every event the register holds of task `id`, in the order they were written, as `show` reads them: from the
 * working set where it holds them all, else from the whole history, whose cost grows with the archive. An archive
 * with a segment gone serves no event and says why, as {@link workingSetOf} does: half a history would read as a
 * whole one.
 */
export async function taskEventsOf(runtime, folder, layout, id) {
    try {
        const recent = await readWorkingSet(runtime.files, layout);
        const snapshot = lacksEventsOf(recent, id) ? await readHistory(runtime.files, layout) : recent;
        return { events: snapshot.read.events.filter((event) => event.id === id), problems: damageOf(snapshot, folder, layout.tail) };
    }
    catch (error) {
        if (error instanceof MissingSegmentError) {
            const segment = servedPathOf(folder, error.path);
            return { events: [], problems: [`${segment}: missing, so the register's archive is incomplete and the task's history cannot be read`] };
        }
        throw error;
    }
}
/**
 * Every event the register ever held, in write order: the archive's segments, then the live log, as `teamrig stats`
 * reads them, since a count over a range reaches past what a compaction left in the working set. Its cost grows with
 * the archive. An archive with a segment gone serves no event and says why, as {@link workingSetOf} does: numbers
 * counted from half a history would read as the whole one's.
 */
export async function wholeHistoryOf(runtime, folder, layout) {
    try {
        const snapshot = await readHistory(runtime.files, layout);
        return { events: snapshot.read.events, problems: damageOf(snapshot, folder, layout.tail) };
    }
    catch (error) {
        if (error instanceof MissingSegmentError) {
            const segment = servedPathOf(folder, error.path);
            return { events: [], problems: [`${segment}: missing, so the register's archive is incomplete and its numbers cannot be counted`] };
        }
        throw error;
    }
}
/** Damaged or newer lines never stop a read; each kind left out is one line, so a reader shows which it is. */
function damageOf(snapshot, folder, path) {
    const { orphans } = snapshot.state;
    const unowned = orphans > 0 ? [`${servedPathOf(folder, path)}: ${orphans} event(s) naming no task left out`] : [];
    return [...skippedOf(folder, path, snapshot.read), ...unowned];
}
/**
 * What the config's own read has to tell, as `configWarnings` tells a person, less the first problem's words: they
 * quote the value found, which no shape was looked for in. `teamrig config validate` prints them to the person.
 */
export function configProblemsOf(folder, load) {
    const name = servedPathOf(folder, load.path);
    const { newerVersion, issues } = load;
    return [
        ...(newerVersion === undefined ? [] : [`${name}: config version ${newerVersion}, from a newer teamrig, read best-effort; update teamrig`]),
        ...(issues.length === 0 ? [] : [`${name}: ${issues.length} problem(s), defaults used; run: teamrig config validate`]),
    ];
}
