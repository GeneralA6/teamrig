import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { jsonObjectOf } from "../doctor/settings-env.js";
import { countOf, mergeCounts, planAllowTrim } from "./allow-rules.js";
/** The plan for one file's text (undefined: no file). A parse error's message is never kept: it can quote the file. */
export function planFile(permissions, file, text, keep, mode, secrets) {
    if (text === undefined) {
        return { file, kind: 'absent' };
    }
    const json = jsonObjectOf(text);
    if (json === undefined) {
        return { file, kind: 'unreadable', why: 'not a JSON object' };
    }
    const allow = permissions.read(json).allow;
    if (!allow.ok) {
        return { file, kind: 'unreadable', why: allow.problem };
    }
    const trim = planAllowTrim(allow.value, keep, mode, secrets);
    const rewrites = trim.after.length < allow.value.length && file.kind !== 'shared';
    const written = rewrites ? permissions.writeAllow(json, trim.after) : undefined;
    if (written !== undefined && !written.ok) {
        return { file, kind: 'unreadable', why: written.problem };
    }
    const next = written === undefined ? undefined : settingsText(written.value);
    return { file, kind: 'read', text, total: allow.value.length, trim, next };
}
/** The plan of every file in scope, read now. */
export async function planScope(permissions, files, scope, keep, mode, secrets) {
    return Promise.all(scope.map(async (file) => planFile(permissions, file, await files.read(file.path), keep, mode, secrets)));
}
/** What a `wide` plan of the scope would remove, shared files apart: the flag doctor and the lead's start show. */
export function wideAllowOf(plans) {
    const holding = plans.filter((plan) => plan.kind === 'read' && countOf(plan.trim.removed) > 0);
    const of = (shared) => {
        const these = holding.filter((plan) => (plan.file.kind === 'shared') === shared);
        return { files: these.length, counts: mergeCounts(these.map((plan) => plan.trim.removed)) };
    };
    return { local: of(false), committed: of(true) };
}
/** Settings as the host writes them: two-space JSON and a final line break. */
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
function allowOf(permissions, text) {
    const json = text === undefined ? undefined : jsonObjectOf(text);
    const allow = json === undefined ? undefined : permissions.read(json).allow;
    return allow?.ok === true ? allow.value : undefined;
}
function sameList(left, right) {
    return left.length === right.length && left.every((rule, index) => rule === right[index]);
}
/**
 * Backs up every file it rewrites into `backupDir` (which must be new: a name already taken there stops the trim
 * before any settings file is written), writes the manifest, then rewrites each file that still holds the text it was
 * planned from and reads it back.
 */
export async function applyTrim(permissions, files, plans, backupDir, now) {
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
        written.push({ plan, backup: join(backupDir, name), result: await rewrite(permissions, files, plan) });
    }
    return written;
}
async function claim(files, path, text) {
    if (!(await files.createExclusive(path, text))) {
        throw new Error(`${path} already exists; nothing written, run the trim again`);
    }
}
async function rewrite(permissions, files, plan) {
    if ((await files.read(plan.file.path)) !== plan.text) {
        return 'changed-since-read';
    }
    await files.write(plan.file.path, plan.next);
    const after = allowOf(permissions, await files.read(plan.file.path));
    return after !== undefined && sameList(after, plan.trim.after) ? 'wrote' : 'not-verified';
}
