import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, isStringArray } from '../core/guards.ts';
import type { Env } from '../core/home.ts';
import { jsonObjectOf } from '../doctor/settings-env.ts';
import { countOf, mergeCounts, planAllowTrim, type AllowTrim, type ClassCounts, type KeepList, type SecretFinder, type TrimMode } from './allow-rules.ts';
import type { SettingsFile } from './settings-scope.ts';

/**
 * `teamrig permissions trim`: plan, then apply, the removal of local allow rules off the team's keep-list. Only
 * `permissions.allow` changes; every other key stays, in its order. A file that is not a JSON object, or whose
 * `permissions.allow` is not a list of texts, is left as it is. Before anything is written each file's old text goes to
 * a fresh backup folder with a manifest (path, sha256, rule count); a file that changed since it was read is skipped,
 * and each written file is read back and its allow list compared.
 */

/** What a trim finds in one settings file. The rules' text stays in `text` and `next`, which no report prints. */
export type FilePlan =
  | { readonly file: SettingsFile; readonly kind: 'absent' }
  | { readonly file: SettingsFile; readonly kind: 'unreadable'; readonly why: string }
  | {
      readonly file: SettingsFile;
      readonly kind: 'read';
      readonly text: string;
      /** The allow rules there now. */
      readonly total: number;
      readonly trim: AllowTrim;
      /** The file's new text, when a trim rewrites it: something to remove, and not a shared file. */
      readonly next: string | undefined;
    };

/** The plan a read plan carries; the narrowing the report and the apply step share. */
export type ReadPlan = Extract<FilePlan, { kind: 'read' }>;

/** The plan for one file's text (undefined: no file). A parse error's message is never kept: it can quote the file. */
export function planFile(file: SettingsFile, text: string | undefined, keep: KeepList, mode: TrimMode, secrets: SecretFinder): FilePlan {
  if (text === undefined) {
    return { file, kind: 'absent' };
  }
  const json = jsonObjectOf(text);
  if (json === undefined) {
    return { file, kind: 'unreadable', why: 'not a JSON object' };
  }
  const permissions = json['permissions'] ?? {};
  if (!isRecord(permissions)) {
    return { file, kind: 'unreadable', why: 'permissions is not an object' };
  }
  const allow = permissions['allow'] ?? [];
  if (!isStringArray(allow)) {
    return { file, kind: 'unreadable', why: 'permissions.allow is not a list of texts' };
  }
  const trim = planAllowTrim(allow, keep, mode, secrets);
  const rewrites = trim.after.length < allow.length && file.kind !== 'shared';
  const next = rewrites ? settingsText({ ...json, permissions: { ...permissions, allow: trim.after } }) : undefined;
  return { file, kind: 'read', text, total: allow.length, trim, next };
}

/** The plan of every file in scope, read now. */
export async function planScope(files: Files, scope: readonly SettingsFile[], keep: KeepList, mode: TrimMode, secrets: SecretFinder): Promise<FilePlan[]> {
  return Promise.all(scope.map(async (file) => planFile(file, await files.read(file.path), keep, mode, secrets)));
}

/** The rules off the keep-list that approve a whole tool or program or hold a credential: how many files hold them, and their classes. */
export interface WideAllow {
  readonly files: number;
  readonly counts: ClassCounts;
}

/** What a `wide` plan of the scope would remove, shared files too: the flag doctor and the lead's start show. */
export function wideAllowOf(plans: readonly FilePlan[]): WideAllow {
  const holding = plans.filter((plan): plan is ReadPlan => plan.kind === 'read' && countOf(plan.trim.removed) > 0);
  return { files: holding.length, counts: mergeCounts(holding.map((plan) => plan.trim.removed)) };
}

/** Settings as Claude Code writes them: two-space JSON and a final line break. */
function settingsText(json: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** A plan a trim rewrites the file of. */
export type Rewrite = ReadPlan & { readonly next: string };

/** The plans a trim rewrites the files of. */
export function rewritesOf(plans: readonly FilePlan[]): Rewrite[] {
  return plans.filter((plan): plan is Rewrite => plan.kind === 'read' && plan.next !== undefined);
}

/**
 * The person's own state folder, outside the kit home that every session reads: `%LOCALAPPDATA%` on Windows, else
 * `$XDG_STATE_HOME`, else `~/.local/state`.
 */
export function ownerStateDir(env: Env, userHome: string, platform: NodeJS.Platform): string {
  const named = [platform === 'win32' ? env['LOCALAPPDATA'] : undefined, env['XDG_STATE_HOME']].map((dir) => dir?.trim());
  return named.find((dir): dir is string => dir !== undefined && dir !== '') ?? join(userHome, '.local', 'state');
}

/** A backup folder's name: the UTC second, as `20261023T122100Z`. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export const MANIFEST = 'manifest.json';

/** How one rewrite went. */
export type WriteResult = 'wrote' | 'changed-since-read' | 'not-verified';

export interface TrimWrite {
  readonly plan: Rewrite;
  /** The old text's copy in the backup folder. */
  readonly backup: string;
  readonly result: WriteResult;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The allow list of a file as written, or undefined when it cannot be read as one. */
function allowOf(text: string | undefined): readonly string[] | undefined {
  const permissions = text === undefined ? undefined : jsonObjectOf(text)?.['permissions'];
  const allow = isRecord(permissions) ? permissions['allow'] : undefined;
  return isStringArray(allow) ? allow : undefined;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}

/**
 * Backs up every file it rewrites into `backupDir` (which must be new: a name already taken there stops the trim
 * before any settings file is written), writes the manifest, then rewrites each file that still holds the text it was
 * planned from and reads it back.
 */
export async function applyTrim(files: Files, plans: readonly FilePlan[], backupDir: string, now: number): Promise<TrimWrite[]> {
  const steps = rewritesOf(plans).map((plan, index) => ({ plan, name: `${String(index + 1).padStart(2, '0')}-${basename(plan.file.path)}` }));
  for (const { plan, name } of steps) {
    await claim(files, join(backupDir, name), plan.text);
  }
  const manifest = {
    createdAt: new Date(now).toISOString(),
    files: steps.map(({ plan, name }) => ({ path: plan.file.path, backup: name, sha256: sha256(plan.text), rules: plan.total })),
  };
  await claim(files, join(backupDir, MANIFEST), settingsText(manifest));
  const written: TrimWrite[] = [];
  for (const { plan, name } of steps) {
    written.push({ plan, backup: join(backupDir, name), result: await rewrite(files, plan) });
  }
  return written;
}

async function claim(files: Files, path: string, text: string): Promise<void> {
  if (!(await files.createExclusive(path, text))) {
    throw new Error(`${path} already exists; nothing written, run the trim again`);
  }
}

async function rewrite(files: Files, plan: Rewrite): Promise<WriteResult> {
  if ((await files.read(plan.file.path)) !== plan.text) {
    return 'changed-since-read';
  }
  await files.write(plan.file.path, plan.next);
  const after = allowOf(await files.read(plan.file.path));
  return after !== undefined && sameList(after, plan.trim.after) ? 'wrote' : 'not-verified';
}
