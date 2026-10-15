import { formatAddress } from "../core/address.js";
import { titleKey } from "../core/ids.js";
import { indexMarks, MARK_VERSION } from "../inbox/marks.js";
/**
 * The sessions of `roster` whose id or current name is `title`, whatever its case (`titleKey`). A former name binds nothing:
 * the title rename that follows would give the session that old name back.
 */
export function sessionsTitled(roster, title) {
    const key = titleKey(title);
    return roster.ids.filter((id) => id === key || roster.nameOf(id) === key);
}
/**
 * The mark that binds `claudeSession` to `area`: the area's newest read position (line, last line's
 * fingerprint and when it was read) under the new Claude Code session, so nothing counts as read that
 * was unread. An area never read gets the position before its first line, dated now.
 */
export function bindMarkOf(newest, area, claudeSession, now) {
    return {
        v: MARK_VERSION,
        area,
        line: newest?.line ?? 0,
        at: newest?.at ?? now.toISOString(),
        claudeSession,
        lastLineHash: newest?.lastLineHash ?? null,
    };
}
/** Binds the tab to the one session of its tree its title names, unless something already names its session. */
export async function bindByTitle(deps, input) {
    if (input.envSession) {
        return { kind: 'kept' };
    }
    const { own, claudeSession } = input;
    const { byArea, areaBySession } = indexMarks((await deps.marks.read()).marks);
    const marked = areaBySession.get(claudeSession);
    if (marked !== undefined && own.roster.ids.includes(marked)) {
        return { kind: 'kept' };
    }
    const title = input.title?.trim();
    if (title === undefined || title === '') {
        return { kind: 'untitled' };
    }
    const ownIds = sessionsTitled(own.roster, title);
    if (ownIds.length === 0) {
        return { kind: 'unmatched', title };
    }
    const others = (await deps.treeTeams()).flatMap(({ team, roster }) => sessionsTitled(roster, title).map((id) => ({ team, id })));
    const candidates = [...ownIds.map((id) => ({ team: own.team, id })), ...others];
    const [only] = candidates;
    if (candidates.length !== 1 || only === undefined) {
        return { kind: 'ambiguous', title, candidates };
    }
    const mark = bindMarkOf(byArea.get(only.id), only.id, claudeSession, input.now);
    await deps.marks.append(mark);
    return { kind: 'bound', id: only.id, mark };
}
/** The prompt hook's line for a tab just bound: which session it is now, and that nothing was marked read. */
export function boundPromptNote(outcome, own, command) {
    return outcome.kind === 'bound'
        ? `${command}: this tab is now the \`${outcome.id}\` session of team ${own.team} (name \`${own.roster.nameOf(outcome.id) ?? outcome.id}\`), from its Claude Code title; nothing was marked read.`
        : undefined;
}
/** The SessionStart note for a tab bound as it started. */
export function boundStartNote(outcome) {
    return outcome.kind === 'bound'
        ? `This tab was bound to the \`${outcome.id}\` session from its Claude Code title; nothing was marked read.`
        : undefined;
}
/** Why a tab is not bound, as the hint log keys it: each reason is told once per Claude Code session. */
export function hintReason(outcome) {
    switch (outcome.kind) {
        case 'kept':
        case 'bound':
            return undefined;
        case 'untitled':
        case 'failed':
            return outcome.kind;
        case 'unmatched':
        case 'ambiguous':
            return `${outcome.kind}:${outcome.title}`;
    }
}
/**
 * The prompt hook's one line for a tab it could not bind: why, and how to bind it. Undefined when
 * the tab is bound or `$TEAMRIG_SESSION` names its session.
 */
export function bindHint(outcome, own, command) {
    const how = `/rename the tab to its session's id or name, or run \`${command} inbox read --session <id>\` (ids: ${own.roster.ids.join(', ')})`;
    switch (outcome.kind) {
        case 'kept':
        case 'bound':
            return undefined;
        case 'untitled':
            return `${command}: this tab is not bound to a session of team ${own.team}. To bind it, ${how}.`;
        case 'unmatched':
            return `${command}: this tab's title "${outcome.title}" names no session of team ${own.team}, so it is not bound. To bind it, ${how}.`;
        case 'ambiguous':
            return `${command}: this tab's title "${outcome.title}" names ${outcome.candidates.map(formatAddress).join(' and ')}, so it is not bound. To bind it, /rename the tab to the session's name (\`${command} who\` lists them), or run \`${command} inbox read --session <id>\`.`;
        case 'failed':
            return `${command}: this tab could not be bound by its title (${outcome.error}); the next prompt tries again.`;
    }
}
