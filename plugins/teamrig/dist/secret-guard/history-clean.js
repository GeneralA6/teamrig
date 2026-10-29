import { join } from 'node:path';
import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
/** Plans over a history that keeps changing between the read and the write before the clean gives up on it. */
const ATTEMPTS = 3;
const PASTE_SUFFIX = '.txt';
/** The history places in Claude Code's folder (`claudeConfigDir`). */
export function historyPlaces(claudeDir) {
    return { history: join(claudeDir, 'history.jsonl'), pasteCache: join(claudeDir, 'paste-cache') };
}
/**
 * Removes every trace of the secrets `hashes` name from Claude Code's prompt history (T1481): each paste-cache file
 * holding one, then each history line holding one or naming a removed paste. Every other line is kept byte for byte:
 * Claude Code writes the history as UTF-8 JSON, so `Files.read` gives back exactly what is on disk. The history is
 * read again before the write; when it changed (Claude Code appended a prompt), the plan is made again over the new
 * text, so no line written meanwhile is lost.
 */
export async function cleanHistory(files, places, secrets, hashes) {
    const hits = new Set();
    const removedPastes = new Set();
    for (const name of await files.list(places.pasteCache)) {
        if (!name.endsWith(PASTE_SUFFIX)) {
            continue;
        }
        const path = join(places.pasteCache, name);
        const found = secrets.hashesIn((await files.read(path)) ?? '', hashes);
        if (found.length > 0) {
            await files.remove(path);
            removedPastes.add(name.slice(0, -PASTE_SUFFIX.length));
            found.forEach((hash) => hits.add(hash));
        }
    }
    let text = await files.read(places.history);
    for (let attempt = 0; attempt < ATTEMPTS && text !== undefined; attempt += 1) {
        const plan = planClean(text, secrets, hashes, removedPastes);
        if (plan.removed === 0) {
            return { lines: 0, pastes: removedPastes.size, hits, settled: true };
        }
        const current = await files.read(places.history);
        if (current === text) {
            await files.write(places.history, plan.kept);
            plan.hits.forEach((hash) => hits.add(hash));
            return { lines: plan.removed, pastes: removedPastes.size, hits, settled: true };
        }
        text = current;
    }
    return { lines: 0, pastes: removedPastes.size, hits, settled: text === undefined };
}
function planClean(text, secrets, hashes, removedPastes) {
    // Each line keeps its own ending, so the kept lines join back into the file byte for byte.
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const hits = new Set();
    let kept = '';
    let removed = 0;
    for (const line of lines) {
        // A line that is not a JSON object is not Claude Code's: it is kept as it is.
        const record = parseObject(line);
        const verdict = record === undefined ? KEEP : judgeLine(record, secrets, hashes, removedPastes);
        if (verdict.drop) {
            removed += 1;
            verdict.hits.forEach((hash) => hits.add(hash));
        }
        else {
            kept += line;
        }
    }
    return { kept, removed, hits };
}
const KEEP = { drop: false, hits: [] };
/** A history line goes when its prompt or one of its pastes holds a wanted secret, or it names a removed paste. */
function judgeLine(record, secrets, hashes, removedPastes) {
    const hits = secrets.hashesIn(stringField(record, 'display') ?? '', hashes);
    let namesRemovedPaste = false;
    for (const paste of Object.values(recordField(record, 'pastedContents') ?? {})) {
        if (!isRecord(paste)) {
            continue;
        }
        hits.push(...secrets.hashesIn(stringField(paste, 'content') ?? '', hashes));
        const contentHash = stringField(paste, 'contentHash');
        namesRemovedPaste ||= contentHash !== undefined && removedPastes.has(contentHash);
    }
    return { drop: hits.length > 0 || namesRemovedPaste, hits };
}
