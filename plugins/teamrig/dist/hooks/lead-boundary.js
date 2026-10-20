import { basename } from 'node:path';
import { kindOf } from "../budget/patterns.js";
import { runWorkOf, SHELL_DIALECTS } from "../budget/run-work.js";
import { programsOf } from "../package-guard/programs.js";
/** A source file: reading one is research. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sh|ps1|sql)$/i;
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
/** The turn-end line names this many edited files, then counts the rest. */
const MAX_NAMES = 3;
const HAND_OFF = 'The lead hands such work to the owning session (a register task), a helper or a temporary session, and keeps to deciding and briefing [leadBoundary].';
/** A path or command with forward slashes, the home spellings (`~`, `$HOME`, `$env:USERPROFILE`) and Git Bash drives (`/c/`) written out, in lower case. */
function normalized(text, home) {
    return text
        .replace(/\\+/g, '/')
        .replace(/\$\{?HOME\}?|\$env:USERPROFILE|~(?=\/|$)/gi, () => home)
        .replace(/(^|[\s"'=])\/([a-z])\//gi, (_match, before, drive) => `${before}${drive}:/`)
        .toLowerCase();
}
/** The lead's own files and folders (board, notes, agenda, memory): editing or searching them is its job. */
export class OwnPaths {
    /** The user's home, with forward slashes. */
    home;
    within;
    mentioned;
    /** Each glob may start with `~` for the user's home and use `*` for one folder name. */
    constructor(globs, userHome) {
        this.home = userHome.replace(/\\+/g, '/').replace(/\/+$/, '');
        const patterns = globs
            .map((glob) => normalized(glob.trim(), this.home).replace(/\/+$/, ''))
            .filter((glob) => glob !== '')
            .map((glob) => glob.replace(/[.+?^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*'));
        this.within = patterns.map((pattern) => new RegExp(`^${pattern}(?:/|$)`));
        this.mentioned = patterns.map((pattern) => new RegExp(`${pattern}(?:/|$|[\\s"';|&)])`, 'm'));
    }
    /** The path is one of the lead's own files or folders, or inside one. */
    owns(path) {
        const target = normalized(path, this.home);
        return this.within.some((pattern) => pattern.test(target));
    }
    /** The shell command names one of the lead's own files or folders. */
    named(command) {
        const text = normalized(command, this.home);
        return this.mentioned.some((pattern) => pattern.test(text));
    }
}
/** What one program a shell call starts does that the lead hands off; undefined for anything else. */
function leadRunWorkOf(run) {
    switch (runWorkOf(run)) {
        case 'edit':
            return 'edit';
        case 'gitPatch':
        case 'gitWrite':
            return 'git';
        case 'testFull':
        case 'testTargeted':
        case 'build':
            return 'check';
        case 'search':
            return 'search';
        default:
            return undefined;
    }
}
/** A shell call by the programs it starts: an edit before a test or build before a search; a line naming the lead's own files is its job. */
function shellWorkOf(command, dialect, own) {
    const works = new Set(programsOf(command, { cwd: undefined, home: own.home, dialect }).map(leadRunWorkOf));
    if (works.has('git') || works.has('edit')) {
        return own.named(command) ? undefined : { work: 'edit', name: works.has('git') ? 'git' : 'shell' };
    }
    if (works.has('check')) {
        return { work: 'check', name: 'shell' };
    }
    return works.has('search') && !own.named(command) ? { work: 'search', name: 'shell' } : undefined;
}
function callWorkOf(tool, own) {
    const dialect = SHELL_DIALECTS.get(tool.name);
    if (dialect !== undefined) {
        return shellWorkOf(tool.command ?? '', dialect, own);
    }
    const path = tool.path;
    const mine = path !== undefined && own.owns(path);
    const name = path === undefined ? 'shell' : basename(path.replace(/\\/g, '/'));
    if (kindOf(tool) === 'edit') {
        return mine ? undefined : { work: 'edit', name };
    }
    if (tool.name === 'Read') {
        return path !== undefined && CODE_FILE.test(path) && !mine ? { work: 'search', name } : undefined;
    }
    return SEARCH_TOOLS.has(tool.name) && !mine ? { work: 'search', name } : undefined;
}
/** What one of the lead's calls did that it hands off; undefined for its own job. */
export function leadWorkOf(tool, own) {
    return callWorkOf(tool, own)?.work;
}
/** The hand-off work among a turn's calls. */
export function leadTallyOf(turn, own) {
    let edits = 0;
    let checks = 0;
    let searches = 0;
    const edited = [];
    for (const tool of turn) {
        const call = callWorkOf(tool, own);
        switch (call?.work) {
            case 'edit': {
                edits += 1;
                if (!edited.includes(call.name)) {
                    edited.push(call.name);
                }
                break;
            }
            case 'check':
                checks += 1;
                break;
            case 'search':
                searches += 1;
                break;
            case undefined:
                break;
        }
    }
    return { edits, edited, checks, searches };
}
/**
 * The line for the lead's model after `current`, once a turn per kind: at its first edit, its first
 * test or build, and its `searchNudgeAt`-th code search (0: never for searches). `turn` includes `current`.
 */
export function leadNudgeLine(turn, current, own, searchNudgeAt) {
    const tally = leadTallyOf(turn, own);
    const call = callWorkOf(current, own);
    switch (call?.work) {
        case 'edit':
            return tally.edits === 1 ? `teamrig: the lead edited ${call.name} itself. ${HAND_OFF}` : undefined;
        case 'check':
            return tally.checks === 1 ? `teamrig: the lead ran a test or a build itself. ${HAND_OFF}` : undefined;
        case 'search':
            return searchNudgeAt > 0 && tally.searches === searchNudgeAt ? `teamrig: the lead made ${searchNudgeAt} code searches itself this turn. ${HAND_OFF}` : undefined;
        case undefined:
            return undefined;
    }
}
function counted(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}
/** The owner's turn-end line when the lead did hand-off work itself; searches count from `searchNudgeAt` (0: never). */
export function leadStopLine(tally, searchNudgeAt) {
    const more = tally.edited.length - MAX_NAMES;
    const names = tally.edited.slice(0, MAX_NAMES).join(', ') + (more > 0 ? ` +${more} more` : '');
    const parts = [
        ...(tally.edits === 0 ? [] : [`${counted(tally.edits, 'edit', 'edits')} (${names})`]),
        ...(tally.checks === 0 ? [] : [counted(tally.checks, 'test or build', 'tests or builds')]),
        ...(searchNudgeAt > 0 && tally.searches >= searchNudgeAt ? [counted(tally.searches, 'code search', 'code searches')] : []),
    ];
    return parts.length === 0 ? undefined : `Lead boundary: this turn the lead did ${parts.join(', ')} itself; it delegates such work [leadBoundary].`;
}
