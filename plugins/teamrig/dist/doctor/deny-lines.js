import { recordField } from "../core/guards.js";
import { jsonObjectOf } from "./settings-env.js";
/**
 * The `permissions.deny` lines that keep a session's tools off the well-known credential homes. A deny line beats any
 * hook's allow and auto mode's classifier, so it holds where a read-only allow hook would approve `cat` of a secret
 * file. teamrig never writes permissions: doctor and `check` print the missing ones for the user to paste.
 *
 * Verified with canaries on Claude Code 2.1.303 (10-19, skill security-deny-verify): each of the first eleven refuses
 * its call; a Read deny also refuses Write and Edit of the path, and Grep skips the file. The rest are the same rule
 * forms on other paths. A rule ending in `:*` is the legacy prefix form, so `PowerShell(Get-ChildItem env:*)` misses
 * `Get-ChildItem env:X`; `env*` matches both.
 */
export const SECRET_DENY_LINES = [
    'Read(//**/secrets.yaml)',
    'Read(//**/.env)',
    'Read(~/.npmrc)',
    'Bash(kubectl *get*secret*)',
    'Bash(kubectl exec *printenv*)',
    'Bash(kubectl exec *-- env*)',
    'Bash(env)',
    'Bash(printenv*)',
    'PowerShell(Get-Content *secrets.yaml*)',
    'PowerShell(Get-Content *.env*)',
    'PowerShell(Get-ChildItem env*)',
    'Read(~/.ssh/id_*)',
    'Read(~/.aws/credentials)',
    'Read(~/.kube/config)',
    'Read(~/.docker/config.json)',
    'Read(~/.git-credentials)',
    'Read(~/.config/gh/hosts.yml)',
    'Read(//**/*.pem)',
    'Read(//**/*.key)',
];
async function readOne(files, path) {
    const text = await files.read(path);
    if (text === undefined) {
        return undefined;
    }
    const settings = jsonObjectOf(text);
    if (settings === undefined) {
        return { kind: 'unreadable', path };
    }
    const list = recordField(settings, 'permissions')?.['deny'];
    const deny = Array.isArray(list) ? list.filter((rule) => typeof rule === 'string') : [];
    return { kind: 'deny', path, deny };
}
/** The `permissions.deny` lines of each settings file that exists, in the order given. A missing file is left out; it only reads. */
export async function readSettingsDeny(files, paths) {
    const read = await Promise.all(paths.map((path) => readOne(files, path)));
    return read.filter((settings) => settings !== undefined);
}
/**
 * The secret deny lines no readable file holds, word for word (spaces at either end aside), in `SECRET_DENY_LINES`
 * order. A deny line in any settings file a session reads applies to it, so the files count as one list.
 */
export function missingDenyLines(read) {
    const held = new Set(read.flatMap((settings) => (settings.kind === 'deny' ? settings.deny.map((rule) => rule.trim()) : [])));
    return SECRET_DENY_LINES.filter((line) => !held.has(line));
}
