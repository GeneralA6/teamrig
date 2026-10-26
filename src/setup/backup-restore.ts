import { errorMessage } from '../core/guards.ts';
import { pathKey } from '../core/paths.ts';
import type { BackupEntry, BackupManifest } from './backup-manifest.ts';
import { findSetupPlaces } from './backup-places.ts';
import { sha256Of, storedPath, type SetupPorts } from './backup.ts';

/**
 * What a restore does with one file the backup keeps: put its copy back over a changed file or a deleted one, leave
 * a file that matches alone, or write nothing because the copy no longer matches the SHA-256 the manifest recorded.
 */
export type RestoreAction = 'restore' | 'recreate' | 'unchanged' | 'damaged';

export interface PlannedFile {
  readonly entry: BackupEntry;
  readonly action: RestoreAction;
}

/** A restore worked out without writing: no file's bytes are held, so a restore re-reads and re-checks each copy. */
export interface RestorePlan {
  readonly files: readonly PlannedFile[];
  /** The setup's files now that the backup does not keep, which only `--remove-new` removes. */
  readonly added: readonly string[];
}

/** What a restore did to one file; `failed` says why it was not done. */
export interface RestoreOutcome {
  readonly path: string;
  readonly step: 'restore' | 'recreate' | 'remove';
  readonly failed: string | undefined;
}

/** True when the bytes are there and are the ones the manifest recorded. */
function matches(bytes: Uint8Array | undefined, entry: BackupEntry): bytes is Uint8Array {
  return bytes !== undefined && sha256Of(bytes) === entry.sha256;
}

async function actionOf(ports: SetupPorts, dir: string, entry: BackupEntry): Promise<RestoreAction> {
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
export async function planRestore(ports: SetupPorts, dir: string, manifest: BackupManifest): Promise<RestorePlan> {
  const files: PlannedFile[] = [];
  for (const entry of manifest.files) {
    files.push({ entry, action: await actionOf(ports, dir, entry) });
  }
  const kept = new Set(manifest.files.map((entry) => pathKey(entry.source)));
  const places = await findSetupPlaces(ports, { claudeDir: manifest.claudeDir, project: manifest.project, teamSkills: manifest.teamSkills });
  const added = places.files.filter((file) => !kept.has(pathKey(file.source))).map((file) => file.source);
  return { files, added };
}

/** Writes the copy back only when it still matches its manifest entry, and reads the file back to see it written. */
async function writeBack(ports: SetupPorts, dir: string, entry: BackupEntry): Promise<void> {
  const copy = await ports.bytes.read(storedPath(dir, entry.stored));
  if (!matches(copy, entry)) {
    throw new Error('its backup copy changed since the preview; not written');
  }
  await ports.bytes.write(entry.source, copy);
  if (!matches(await ports.bytes.read(entry.source), entry)) {
    throw new Error('the file read back differs from its backup copy');
  }
}

async function failureOf(step: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await step();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Puts back each changed or deleted file of `plan` from the backup in `dir`, and with `removeNew` removes the files
 * made since. A failed file is reported and the rest still go ahead, so one locked file cannot strand the others.
 */
export async function applyRestore(ports: SetupPorts, dir: string, plan: RestorePlan, removeNew: boolean): Promise<RestoreOutcome[]> {
  const outcomes: RestoreOutcome[] = [];
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
