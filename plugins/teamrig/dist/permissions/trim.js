import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { isRecord, isStringArray } from "../core/guards.js";
import { jsonObjectOf } from "../doctor/settings-env.js";
import { countOf, mergeCounts, planAllowTrim } from "./allow-rules.js";
/** The plan for one file's text (undefined: no file). A parse error's message is never kept: it can quote the file. */
export function planFile(file, text, keep, mode, secrets) {
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
export async function planScope(files, scope, keep, mode, secrets) {
    return Promise.all(scope.map(async (file) => planFile(file, await files.read(file.path), keep, mode, secrets)));
}
/** What a `wide` plan of the scope would remove, shared files too: the flag doctor and the lead's start show. */
export function wideAllowOf(plans) {
    const holding = plans.filter((plan) => plan.kind === 'read' && countOf(plan.trim.removed) > 0);
    return { files: holding.length, counts: mergeCounts(holding.map((plan) => plan.trim.removed)) };
}
/** Settings as Claude Code writes them: two-space JSON and a final line break. */
function settingsText(json) {
    return `${JSON.stringify(json, null, 2)}\n`;
}
/** The plans a trim rewrites the files of. */
export function rewritesOf(plans) {
    return plans.filter((plan) => plan.kind === 'read' && plan.next !== undefined);
}
/**
 * The person's own state folder, outside the kit home that every session reads: `%LOCALAPPDATA%` on Windows, else
 * `$XDG_STATE_HOME`, else `~/.local/state`.
 */
export function ownerStateDir(env, userHome, platform) {
    const named = [platform === 'win32' ? env['LOCALAPPDATA'] : undefined, env['XDG_STATE_HOME']].map((dir) => dir?.trim());
    return named.find((dir) => dir !== undefined && dir !== '') ?? join(userHome, '.local', 'state');
}
/** A backup folder's name: the UTC second, as `20261023T122100Z`. */
export function backupStamp(now) {
    return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
export const MANIFEST = 'manifest.json';
function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** The allow list of a file as written, or undefined when it cannot be read as one. */
function allowOf(text) {
    const permissions = text === undefined ? undefined : jsonObjectOf(text)?.['permissions'];
    const allow = isRecord(permissions) ? permissions['allow'] : undefined;
    return isStringArray(allow) ? allow : undefined;
}
function sameList(left, right) {
    return left.length === right.length && left.every((rule, index) => rule === right[index]);
}
/**
 * Backs up every file it rewrites into `backupDir` (which must be new: a name already taken there stops the trim
 * before any settings file is written), writes the manifest, then rewrites each file that still holds the text it was
 * planned from and reads it back.
 */
export async function applyTrim(files, plans, backupDir, now) {
    const steps = rewritesOf(plans).map((plan, index) => ({ plan, name: `${String(index + 1).padStart(2, '0')}-${basename(plan.file.path)}` }));
    for (const { plan, name } of steps) {
        await claim(files, join(backupDir, name), plan.text);
    }
    const manifest = {
        createdAt: new Date(now).toISOString(),
        files: steps.map(({ plan, name }) => ({ path: plan.file.path, backup: name, sha256: sha256(plan.text), rules: plan.total })),
    };
    await claim(files, join(backupDir, MANIFEST), settingsText(manifest));
    const written = [];
    for (const { plan, name } of steps) {
        written.push({ plan, backup: join(backupDir, name), result: await rewrite(files, plan) });
    }
    return written;
}
async function claim(files, path, text) {
    if (!(await files.createExclusive(path, text))) {
        throw new Error(`${path} already exists; nothing written, run the trim again`);
    }
}
async function rewrite(files, plan) {
    if ((await files.read(plan.file.path)) !== plan.text) {
        return 'changed-since-read';
    }
    await files.write(plan.file.path, plan.next);
    const after = allowOf(await files.read(plan.file.path));
    return after !== undefined && sameList(after, plan.trim.after) ? 'wrote' : 'not-verified';
}
