import { dirname, join } from 'node:path';
import { isRecord, recordField } from "../core/guards.js";
import { sha256Hex } from "./digest.js";
/**
 * The client pin (T755, spec §2.2, phase 1): the build lists a hash of every file of the plugin's client, and the exec
 * guard checks the installed plugin against that list before a `teamrig exec` call runs, so a session that edited the
 * installed client by hand (a hot patch) runs no request through it. The list sits beside the code it lists, so it
 * stops a slip, not a session set on getting around it: phase 2 makes the install read-only to agent accounts.
 */
/** The plugin folders whose files make the client: its launchers, its compiled code and the hooks that guard it. */
export const CLIENT_FOLDERS = ['bin', 'dist', 'hooks'];
/** Where the build writes the list, relative to the plugin root; the list never lists itself. */
export const CLIENT_MANIFEST = 'dist/integrity.json';
/** The hash of one client file's text, with CRLF read as LF: a checkout's line endings never count as a change. */
export function clientFileHash(text) {
    return sha256Hex(text.replace(/\r\n/g, '\n'));
}
/** The list as the build writes it: one key per file, sorted, so a rebuild of unchanged code writes the same text. */
export function clientManifestText(manifest) {
    const files = Object.fromEntries([...manifest].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    return `${JSON.stringify({ files }, null, 2)}\n`;
}
/** The list a manifest text holds, or undefined when it is not one. */
export function parseClientManifest(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const files = isRecord(value) ? recordField(value, 'files') : undefined;
    if (files === undefined) {
        return undefined;
    }
    const entries = Object.entries(files);
    if (entries.length === 0) {
        return undefined;
    }
    const manifest = new Map();
    for (const [path, hash] of entries) {
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
            return undefined;
        }
        manifest.set(path, hash);
    }
    return manifest;
}
/** The plugin root of the client whose entry script this is: `<root>/dist/cli/main.js`. */
export function clientRootOf(script) {
    return dirname(dirname(dirname(script)));
}
/** Checks the client installed at `pluginRoot` against the list the build wrote there. It never throws. */
export async function checkClient(pluginRoot, files) {
    const text = await files.read(join(pluginRoot, CLIENT_MANIFEST)).catch(() => undefined);
    if (text === undefined) {
        return { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is missing` };
    }
    const manifest = parseClientManifest(text);
    if (manifest === undefined) {
        return { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is not a list of file hashes` };
    }
    const changed = [];
    for (const [path, hash] of manifest) {
        const current = await files.read(join(pluginRoot, path)).catch(() => undefined);
        if (current === undefined || clientFileHash(current) !== hash) {
            changed.push(path);
        }
    }
    return changed.length === 0 ? { kind: 'intact' } : { kind: 'changed', paths: changed };
}
