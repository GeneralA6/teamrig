import { errorMessage } from "../core/guards.js";
import { pathKey } from "../core/paths.js";
import { findSetupPlaces } from "./backup-places.js";
import { sha256Of, storedPath } from "./backup.js";
/** True when the bytes are there and are the ones the manifest recorded. */
function matches(bytes, entry) {
    return bytes !== undefined && sha256Of(bytes) === entry.sha256;
}
async function actionOf(ports, dir, entry) {
    if (!matches(await ports.bytes.read(storedPath(dir, entry.stored)), entry)) {
        return 'damaged';
    }
    const current = await ports.bytes.read(entry.source);
    if (current === undefined) {
        return 'recreate';
    }
    return matches(current, entry) ? 'unchanged' : 'restore';
}
/**
 * Compares the setup the backup in `dir` was made of with its manifest, one file at a time so no more than two
 * files are read at once, and finds the setup files made since, the same way the backup found its own.
 */
export async function planRestore(ports, dir, manifest) {
    const files = [];
    for (const entry of manifest.files) {
        files.push({ entry, action: await actionOf(ports, dir, entry) });
    }
    const kept = new Set(manifest.files.map((entry) => pathKey(entry.source)));
    const places = await findSetupPlaces(ports, { claudeDir: manifest.claudeDir, project: manifest.project });
    const added = places.files.filter((file) => !kept.has(pathKey(file.source))).map((file) => file.source);
    return { files, added };
}
/** Writes the copy back only when it still matches its manifest entry, and reads the file back to see it written. */
async function writeBack(ports, dir, entry) {
    const copy = await ports.bytes.read(storedPath(dir, entry.stored));
    if (!matches(copy, entry)) {
        throw new Error('its backup copy changed since the preview; not written');
    }
    await ports.bytes.write(entry.source, copy);
    if (!matches(await ports.bytes.read(entry.source), entry)) {
        throw new Error('the file read back differs from its backup copy');
    }
}
async function failureOf(step) {
    try {
        await step();
        return undefined;
    }
    catch (error) {
        return errorMessage(error);
    }
}
/**
 * Puts back each changed or deleted file of `plan` from the backup in `dir`, and with `removeNew` removes the files
 * made since. A failed file is reported and the rest still go ahead, so one locked file cannot strand the others.
 */
export async function applyRestore(ports, dir, plan, removeNew) {
    const outcomes = [];
    for (const { entry, action } of plan.files) {
        if (action === 'restore' || action === 'recreate') {
            outcomes.push({ path: entry.source, step: action, failed: await failureOf(() => writeBack(ports, dir, entry)) });
        }
    }
    if (removeNew) {
        for (const path of plan.added) {
            outcomes.push({ path, step: 'remove', failed: await failureOf(() => ports.files.remove(path)) });
        }
    }
    return outcomes;
}
