import { bareName, titleKey, titleParts } from "../core/ids.js";
import { checkRename, recordRename } from "./record.js";
/**
 * Records the title the user gave session `id` in Claude Code as the session's own rename; its id is
 * no rename, since a tab may be titled by its id to bind it (hooks/bind.ts), and neither is the
 * `[<team>] <name>` form of its own name people see (sessionDisplay). The
 * roster read without the lock settles the common cases, the same name or a refused one, so a hook
 * on every prompt takes the lock only to record.
 */
export async function adoptTitle(deps, own, id, title) {
    const { team, roster } = own;
    const parts = titleParts(title);
    const ownBracket = parts.team === team;
    const name = titleKey(ownBracket ? parts.name : title);
    if (name === id) {
        // The id always names the session, so a tab titled by its id (to bind it) keeps the session's name.
        return { kind: 'unchanged' };
    }
    if (ownBracket && bareName(team, name) === bareName(team, roster.nameOf(id) ?? id)) {
        // `[app] scout` shows the session named `app-scout`: its own name as people see it, not a rename to `scout`.
        return { kind: 'unchanged' };
    }
    const request = { id, to: name, by: id };
    const check = checkRename(roster, request);
    if (check.kind === 'unchanged') {
        return { kind: 'unchanged' };
    }
    if (check.kind === 'refused') {
        return { kind: 'refused', title, reason: check.reason };
    }
    const outcome = await recordRename(deps, request);
    switch (outcome.kind) {
        case 'recorded':
            return { kind: 'recorded', rename: outcome.rename };
        case 'unchanged':
            return { kind: 'unchanged' };
        case 'refused':
            return { kind: 'refused', title, reason: outcome.reason };
    }
}
/** The SessionStart note: what happened to the title, or undefined when there is nothing to say. */
export function sessionStartNote(outcome) {
    switch (outcome.kind) {
        case 'none':
        case 'unchanged':
            return undefined;
        case 'recorded':
            return `This session was renamed in Claude Code, so its team name is now \`${outcome.rename.to}\` (was \`${outcome.rename.from}\`); the old name still finds it.`;
        case 'refused':
            return `This session's Claude Code title "${outcome.title}" is not its team name: ${outcome.reason}.`;
        case 'failed':
            return `This session's Claude Code title could not be checked against its team name (${outcome.error}); the next prompt tries again.`;
    }
}
/** The prompt hook's note: one line when a rename was recorded; quiet otherwise, as it runs on every prompt. */
export function promptNote(outcome, command) {
    return outcome.kind === 'recorded'
        ? `${command}: this session's team name is now \`${outcome.rename.to}\` (was \`${outcome.rename.from}\`), from its Claude Code title; the old name still finds it.`
        : undefined;
}
