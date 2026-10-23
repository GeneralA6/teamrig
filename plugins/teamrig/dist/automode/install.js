import { isRecord } from "../core/guards.js";
/**
 * How `teamrig automode install` and `uninstall` change Claude Code's `autoMode.environment` setting: the list of
 * trusted facts auto mode's classifier reads. Install puts the team's lines where its tagged lines were (or at the
 * end), and leaves the person's own lines and other teams' tagged lines as they are. A list without `"$defaults"`
 * replaces Claude Code's built-in entries, so a machine with no list gets `"$defaults"` first and keeps them.
 * Uninstall takes the team's lines out; a list left as only `"$defaults"` reads as no list and is dropped, and so is
 * an `autoMode` left empty. An `autoMode` or a list of any other shape is refused, never rewritten.
 */
export const AUTO_MODE_KEY = 'autoMode';
export const ENVIRONMENT_KEY = 'environment';
/** The list item that stands for Claude Code's built-in environment entries. */
export const DEFAULTS_ITEM = '$defaults';
/** Puts the team's lines in: where its tagged lines were, else at the end of the list. */
export function planInstall(settings, tag, lines) {
    const current = currentOf(settings);
    if (!current.ok) {
        return current;
    }
    const before = current.value.environment ?? [DEFAULTS_ITEM];
    const first = before.findIndex((item) => item.startsWith(tag));
    const kept = before.filter((item) => !item.startsWith(tag));
    const at = first === -1 ? kept.length : first;
    const after = [...kept.slice(0, at), ...lines, ...kept.slice(at)];
    if (current.value.environment !== undefined && sameList(before, after)) {
        return { ok: true, value: { settings: undefined, removed: [], added: [] } };
    }
    const was = current.value.environment ?? [];
    return {
        ok: true,
        value: {
            settings: { ...settings, [AUTO_MODE_KEY]: { ...current.value.autoMode, [ENVIRONMENT_KEY]: after } },
            removed: was.filter((item) => !after.includes(item)),
            added: after.filter((item) => !was.includes(item)),
        },
    };
}
/** Takes the team's lines out; a list or an `autoMode` left with nothing of its own is dropped. */
export function planUninstall(settings, tag) {
    const current = currentOf(settings);
    if (!current.ok) {
        return current;
    }
    const before = current.value.environment ?? [];
    const removed = before.filter((item) => item.startsWith(tag));
    if (removed.length === 0) {
        return { ok: true, value: { settings: undefined, removed: [], added: [] } };
    }
    const after = before.filter((item) => !item.startsWith(tag));
    const others = without(current.value.autoMode, ENVIRONMENT_KEY);
    const autoMode = sameList(after, [DEFAULTS_ITEM]) ? others : { ...others, [ENVIRONMENT_KEY]: after };
    const rest = without(settings, AUTO_MODE_KEY);
    const next = Object.keys(autoMode).length === 0 ? rest : { ...rest, [AUTO_MODE_KEY]: autoMode };
    return { ok: true, value: { settings: next, removed, added: [] } };
}
function currentOf(settings) {
    const autoMode = settings[AUTO_MODE_KEY] ?? {};
    if (!isRecord(autoMode)) {
        return { ok: false, problem: `${AUTO_MODE_KEY} is not an object, so nothing can be added to it` };
    }
    const environment = autoMode[ENVIRONMENT_KEY];
    if (environment === undefined) {
        return { ok: true, value: { autoMode, environment: undefined } };
    }
    if (!Array.isArray(environment) || !environment.every((item) => typeof item === 'string')) {
        return { ok: false, problem: `${AUTO_MODE_KEY}.${ENVIRONMENT_KEY} is not a list of strings: fix it by hand, then run this again` };
    }
    return { ok: true, value: { autoMode, environment } };
}
function without(record, key) {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}
function sameList(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}
