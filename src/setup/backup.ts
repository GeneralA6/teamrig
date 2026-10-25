import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FileBytes } from '../core/file-bytes.ts';
import { KIT_NAME, type Env } from '../core/home.ts';
import { backupStamp, MANIFEST, ownerStateDir } from '../permissions/trim.ts';
import { BACKUP_FORMAT, manifestText, readManifest, type BackupEntry, type BackupManifest, type ManifestRead } from './backup-manifest.ts';
import { findSetupPlaces, SETUP_KINDS, type PlacePorts, type SetupKind, type SetupLocations } from './backup-places.ts';

/** The ports a setup backup and restore use: text files and the probe to find the setup, bytes to copy it exactly. */
export interface SetupPorts extends PlacePorts {
  readonly bytes: FileBytes;
}

/** A setup backup folder's name: the UTC second it was made, as `20261025T120000Z`. */
export const STAMP = /^\d{8}T\d{6}Z$/;

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Where setup backups go: `<the person's state folder>/teamrig/setup-backups`, outside the kit home every session reads. */
export function setupBackupsDir(env: Env, userHome: string, platform: NodeJS.Platform): string {
  return join(ownerStateDir(env, userHome, platform), KIT_NAME, 'setup-backups');
}

/** A kept file's copy in the backup folder `dir`. */
export function storedPath(dir: string, stored: string): string {
  return join(dir, ...stored.split('/'));
}

export interface BackupResult {
  readonly stamp: string;
  readonly dir: string;
  readonly manifest: BackupManifest;
  /** How many files each kind kept, every kind named. */
  readonly counts: ReadonlyMap<SetupKind, number>;
}

/**
 * Copies every file of the setup at `at` byte for byte into `<root>/<UTC second>/files/`, then writes the manifest
 * with each copy's SHA-256 last, so a folder with a manifest holds a whole backup. A file gone between the walk and
 * its copy counts as absent. Nothing is ever overwritten: a folder for that second already there refuses the backup.
 */
export async function backupSetup(ports: SetupPorts, at: SetupLocations, root: string, now: number): Promise<BackupResult> {
  const stamp = backupStamp(now);
  const dir = join(root, stamp);
  if ((await ports.files.list(dir)).length > 0) {
    throw new Error(`setup backup ${stamp} already exists in ${root}; run it again in a second`);
  }
  const places = await findSetupPlaces(ports, at);
  const entries: BackupEntry[] = [];
  const absent = [...places.absent];
  const counts = new Map<SetupKind, number>(SETUP_KINDS.map((kind) => [kind, 0]));
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
  const manifest: BackupManifest = {
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

export interface ListedBackup {
  readonly stamp: string;
  readonly read: ManifestRead;
}

/** The setup backups in `root`, oldest first: each folder named by a UTC second, with its manifest as read. */
export async function listBackups(ports: PlacePorts, root: string): Promise<ListedBackup[]> {
  const stamps = (await ports.files.list(root)).filter((name) => STAMP.test(name)).sort();
  return Promise.all(stamps.map(async (stamp) => ({ stamp, read: await readManifest(ports.files, join(root, stamp)) })));
}
