import { isAbsolute, join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isRecord, isStringArray, stringField } from '../core/guards.ts';
import { pathKey } from '../core/paths.ts';
import { MANIFEST } from '../permissions/trim.ts';
import { sourceOfStored, type SetupLocations, type SkippedFolder } from './backup-places.ts';

/** The manifest format this teamrig writes: 2 added `teamSkills` and the files kept under `files/team-skills/`. */
export const BACKUP_FORMAT = 2;
/** The format before `teamSkills`, still read: a backup made of a setup with no team skills folder of its own. */
const NO_TEAM_SKILLS_FORMAT = 1;

/** One file a setup backup keeps: where it was, its copy's path in the backup folder, its size and its SHA-256. */
export interface BackupEntry {
  readonly source: string;
  readonly stored: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** A setup backup's `manifest.json`, written last, so a folder without one is a backup that did not finish. */
export interface BackupManifest extends SetupLocations {
  readonly format: typeof BACKUP_FORMAT;
  /** When the backup was made, as an ISO time. */
  readonly createdAt: string;
  readonly files: readonly BackupEntry[];
  readonly absent: readonly string[];
  readonly skipped: readonly SkippedFolder[];
}

/** A manifest as the backup folder holds it. */
export type ManifestRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly manifest: BackupManifest };

const SHA256 = /^[0-9a-f]{64}$/;

export function manifestText(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Each item of a JSON array read by `item`; undefined when `value` is no array or any item does not read. */
function listOf<T>(value: unknown, item: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: T[] = [];
  for (const each of value) {
    const read = item(each);
    if (read === undefined) {
      return undefined;
    }
    items.push(read);
  }
  return items;
}

/** An entry whose `source` is where its `stored` path belongs for the setup at `at`; any other is refused. */
function entryOf(value: unknown, at: SetupLocations): BackupEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = stringField(value, 'source');
  const stored = stringField(value, 'stored');
  const sha256 = stringField(value, 'sha256');
  const bytes = value['bytes'];
  const belongs = stored === undefined ? undefined : sourceOfStored(at, stored);
  if (source === undefined || stored === undefined || belongs === undefined || pathKey(source) !== pathKey(belongs)) {
    return undefined;
  }
  return sha256 !== undefined && SHA256.test(sha256) && isNonNegativeInteger(bytes) ? { source: belongs, stored, bytes, sha256 } : undefined;
}

function skippedOf(value: unknown): SkippedFolder | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = stringField(value, 'path');
  const why = stringField(value, 'why');
  return path === undefined || why === undefined ? undefined : { path, why };
}

/** A manifest's `teamSkills`: an absolute path, or absent, as format 1 always is. */
function teamSkillsReads(value: unknown, format: unknown): value is string | undefined {
  return value === undefined || (format === BACKUP_FORMAT && typeof value === 'string' && isAbsolute(value));
}

/**
 * The manifest in `text`, or undefined when it is not one this teamrig wrote (another format, a field missing or
 * edited). A format 1 manifest reads as the current format with no team skills folder.
 */
export function parseManifest(text: string): BackupManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || (value['format'] !== BACKUP_FORMAT && value['format'] !== NO_TEAM_SKILLS_FORMAT)) {
    return undefined;
  }
  const createdAt = stringField(value, 'createdAt');
  const claudeDir = stringField(value, 'claudeDir');
  const project = stringField(value, 'project');
  const teamSkills = value['teamSkills'];
  const absent = value['absent'];
  if (createdAt === undefined || claudeDir === undefined || !isAbsolute(claudeDir) || project === undefined || !isAbsolute(project) || !isStringArray(absent)) {
    return undefined;
  }
  // setup scan tells a backup's age from when it was made.
  if (Number.isNaN(Date.parse(createdAt)) || !teamSkillsReads(teamSkills, value['format'])) {
    return undefined;
  }
  const at: SetupLocations = { claudeDir, project, teamSkills };
  const files = listOf(value['files'], (entry) => entryOf(entry, at));
  const skipped = listOf(value['skipped'], skippedOf);
  return files === undefined || skipped === undefined ? undefined : { format: BACKUP_FORMAT, createdAt, claudeDir, project, teamSkills, files, absent, skipped };
}

/** The manifest of the setup backup in `dir`. */
export async function readManifest(files: Files, dir: string): Promise<ManifestRead> {
  const text = await files.read(join(dir, MANIFEST));
  if (text === undefined) {
    return { kind: 'missing' };
  }
  const manifest = parseManifest(text);
  return manifest === undefined ? { kind: 'unreadable' } : { kind: 'read', manifest };
}
