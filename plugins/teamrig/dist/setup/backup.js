import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KIT_NAME } from "../core/home.js";
import { backupStamp, MANIFEST, ownerStateDir } from "../permissions/trim.js";
import { BACKUP_FORMAT, manifestText, readManifest } from "./backup-manifest.js";
import { findSetupPlaces, SETUP_KINDS } from "./backup-places.js";
/** A setup backup folder's name: the UTC second it was made, as `20261025T120000Z`. */
export const STAMP = /^\d{8}T\d{6}Z$/;
export function sha256Of(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/** Where setup backups go: `<the person's state folder>/teamrig/setup-backups`, outside the kit home every session reads. */
export function setupBackupsDir(env, userHome, platform) {
    return join(ownerStateDir(env, userHome, platform), KIT_NAME, 'setup-backups');
}
/** A kept file's copy in the backup folder `dir`. */
export function storedPath(dir, stored) {
    return join(dir, ...stored.split('/'));
}
/**
 * Copies every file of the setup at `at` byte for byte into `<root>/<UTC second>/files/`, then writes the manifest
 * with each copy's SHA-256 last, so a folder with a manifest holds a whole backup. A file gone between the walk and
 * its copy counts as absent. Nothing is ever overwritten: a folder for that second already there refuses the backup.
 */
export async function backupSetup(ports, at, root, now) {
    const stamp = backupStamp(now);
    const dir = join(root, stamp);
    if ((await ports.files.list(dir)).length > 0) {
        throw new Error(`setup backup ${stamp} already exists in ${root}; run it again in a second`);
    }
    const places = await findSetupPlaces(ports, at);
    const entries = [];
    const absent = [...places.absent];
    const counts = new Map(SETUP_KINDS.map((kind) => [kind, 0]));
    for (const file of places.files) {
        const bytes = await ports.bytes.read(file.source);
        if (bytes === undefined) {
            absent.push(file.source);
            continue;
        }
        const copy = storedPath(dir, file.stored);
        if (!(await ports.bytes.createExclusive(copy, bytes))) {
            throw new Error(`${copy} already exists; nothing more written, run the backup again`);
        }
        entries.push({ source: file.source, stored: file.stored, bytes: bytes.length, sha256: sha256Of(bytes) });
        counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
    }
    const manifest = {
        format: BACKUP_FORMAT,
        createdAt: new Date(now).toISOString(),
        claudeDir: at.claudeDir,
        project: at.project,
        files: entries,
        absent,
        skipped: places.skipped,
    };
    if (!(await ports.files.createExclusive(join(dir, MANIFEST), manifestText(manifest)))) {
        throw new Error(`${join(dir, MANIFEST)} already exists; run the backup again`);
    }
    return { stamp, dir, manifest, counts };
}
/** The setup backups in `root`, oldest first: each folder named by a UTC second, with its manifest as read. */
export async function listBackups(ports, root) {
    const stamps = (await ports.files.list(root)).filter((name) => STAMP.test(name)).sort();
    return Promise.all(stamps.map(async (stamp) => ({ stamp, read: await readManifest(ports.files, join(root, stamp)) })));
}
