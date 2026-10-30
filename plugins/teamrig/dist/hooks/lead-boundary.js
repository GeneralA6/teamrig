import { basename } from 'node:path';
import { WEB_FETCH_TOOL } from "../budget/line.js";
import { kindOf } from "../budget/patterns.js";
import { runWorkOf, SHELL_DIALECTS } from "../budget/run-work.js";
import { programsOf } from "../package-guard/programs.js";
import { TASK_ID } from "../register/model.js";
/** A source file: reading one is research. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sh|ps1|sql)$/i;
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WEB_SEARCH_TOOL = 'WebSearch';
/** The turn-end line names this many edited files or research lookups, then counts the rest; a research nudge names this many owners. */
const MAX_NAMES = 3;
const HAND_OFF = 'The lead hands such work to the owning session (a register task), a helper or a hired worker, and keeps to deciding and briefing [leadBoundary].';
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
const PATH_END = `(?=/|$|[\\s"';|&)])`;
/** The normalized path is the normalized place or inside it. */
function within(target, place) {
    return target === place || target.startsWith(`${place}/`);
}
/** The path's folders below `root`, which holds it. */
function segmentsBelow(target, root) {
    return target === root ? [] : target.slice(root.length + 1).split('/');
}
/**
 * The team's teamrig folder as the lead boundary reads a search of it (T736). The lead's own places there are its
 * config, its rules, the register's state, anything named for the lead and the folders of its own tasks (T1467); a
 * search anywhere else there (another session's notes, handover or task folder, or a shared folder such as all the
 * notes) is research, which the session that owns the question does. So is a search of a sub-team's folder outside
 * its config, rules and state (T1019), which the child team's lead it hangs under answers.
 */
export class TeamFolders {
    root;
    own;
    lead;
    others;
    subTeams;
    tasks;
    taskOwners;
    home;
    mentioned;
    constructor(places, userHome) {
        this.home = userHome.replace(/\\+/g, '/').replace(/\/+$/, '');
        this.root = this.placeOf(places.home);
        this.own = places.own.map((place) => this.placeOf(place));
        this.lead = places.lead.toLowerCase();
        this.others = new Set(places.sessions.map((id) => id.toLowerCase()).filter((id) => id !== this.lead));
        this.subTeams = places.subTeams.map(({ team, home, own, owner }) => ({ team, root: this.placeOf(home), own: own.map((place) => this.placeOf(place)), owner }));
        this.tasks = this.placeOf(places.tasks);
        this.taskOwners = places.taskOwners;
        const roots = [this.root, ...this.subTeams.map((sub) => sub.root)].map((root) => root.replace(/[.+?^${}()|[\]\\*]/g, '\\$&'));
        this.mentioned = new RegExp(`(?:${roots.join('|')})${PATH_END}(?:/[^\\s"';|&)]*)?`, 'g');
    }
    placeOf(path) {
        return normalized(path.trim(), this.home).replace(/\/+$/, '');
    }
    /** The sub-team whose folder holds the path, the deepest when folders nest; undefined when the lead's own folder holds it deeper. */
    subTeamOf(target) {
        const holder = this.subTeams
            .filter((sub) => within(target, sub.root))
            .reduce((deepest, sub) => (deepest === undefined || sub.root.length > deepest.root.length ? sub : deepest), undefined);
        return holder !== undefined && !(within(target, this.root) && this.root.length > holder.root.length) ? holder : undefined;
    }
    /** The task whose folder holds the path, in the register's spelling (`T12`); undefined outside a task folder. */
    taskOf(target) {
        const id = within(target, this.tasks) ? segmentsBelow(target, this.tasks)[0]?.toUpperCase() : undefined;
        return id !== undefined && TASK_ID.test(id) ? id : undefined;
    }
    /**
     * The research a search of `path` is; undefined outside the team's and its sub-teams' folders, in the lead's own
     * places, in its own task's folder and in a sub-team's config, rules and state.
     */
    researchOf(path) {
        const target = this.placeOf(path);
        const sub = this.subTeamOf(target);
        if (sub !== undefined) {
            return sub.own.some((place) => within(target, place)) ? undefined : { name: [sub.team, ...segmentsBelow(target, sub.root).slice(0, 2)].join('/'), owner: sub.owner };
        }
        if (!within(target, this.root) || this.own.some((place) => within(target, place))) {
            return undefined;
        }
        const segments = segmentsBelow(target, this.root);
        const task = this.taskOf(target);
        if (task !== undefined) {
            const owner = this.taskOwners.get(task);
            return owner?.toLowerCase() === this.lead ? undefined : { name: segments.slice(0, 2).join('/'), owner, task };
        }
        const named = segments.map((segment) => segment.replace(/\.md$/, ''));
        if (named.includes(this.lead)) {
            return undefined;
        }
        return { name: segments.slice(0, 2).join('/') || 'the team folder', owner: named.find((segment) => this.others.has(segment)) };
    }
    /** The research a shell search is, from the first path in the team's or a sub-team's folder it names that is research. */
    researchNamed(command) {
        for (const match of normalized(command, this.home).matchAll(this.mentioned)) {
            const research = this.researchOf(match[0]);
            if (research !== undefined) {
                return research;
            }
        }
        return undefined;
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
function researchWork({ name, owner, task }) {
    return { work: 'research', name, ...(owner === undefined ? {} : { owner }), ...(task === undefined ? {} : { task }) };
}
/**
 * A shell call by the programs it starts: an edit before a test or build before research before a search; a line
 * naming the lead's own files is its job, and a search naming another session's place in the team's folder research.
 */
function shellWorkOf(command, dialect, paths) {
    const { own, team } = paths;
    const works = new Set(programsOf(command, { cwd: undefined, home: own.home, dialect }).map(leadRunWorkOf));
    if (works.has('git') || works.has('edit')) {
        return own.named(command) ? undefined : { work: 'edit', name: works.has('git') ? 'git' : 'shell' };
    }
    if (works.has('check')) {
        return { work: 'check', name: 'shell' };
    }
    if (!works.has('search')) {
        return undefined;
    }
    const research = team.researchNamed(command);
    if (research !== undefined) {
        return researchWork(research);
    }
    return own.named(command) ? undefined : { work: 'search', name: 'shell' };
}
/** A web address's host, the name its research has; `a web page` for one that does not parse. */
function hostOf(url) {
    return url !== undefined && URL.canParse(url) ? new URL(url).host : 'a web page';
}
function callWorkOf(tool, paths) {
    if (tool.name === WEB_FETCH_TOOL) {
        return { work: 'research', name: hostOf(tool.url) };
    }
    if (tool.name === WEB_SEARCH_TOOL) {
        return { work: 'research', name: 'a web search' };
    }
    const dialect = SHELL_DIALECTS.get(tool.name);
    if (dialect !== undefined) {
        return shellWorkOf(tool.command ?? '', dialect, paths);
    }
    const path = tool.path;
    const mine = path !== undefined && paths.own.owns(path);
    const name = path === undefined ? 'shell' : basename(path.replace(/\\/g, '/'));
    if (kindOf(tool) === 'edit') {
        return mine ? undefined : { work: 'edit', name };
    }
    if (tool.name === 'Read') {
        return path !== undefined && CODE_FILE.test(path) && !mine ? { work: 'search', name } : undefined;
    }
    if (!SEARCH_TOOLS.has(tool.name)) {
        return undefined;
    }
    const research = path === undefined ? undefined : paths.team.researchOf(path);
    if (research !== undefined) {
        return researchWork(research);
    }
    return mine ? undefined : { work: 'search', name };
}
/** What one of the lead's calls did that it hands off; undefined for its own job. */
export function leadWorkOf(tool, paths) {
    return callWorkOf(tool, paths)?.work;
}
/**
 * The tasks whose folders the calls search as research, each once: the register is read for their owners only when
 * there are some (T1467), since `paths` without an owner reads the lead's own task's folder as research too.
 */
export function tasksSearched(turn, paths) {
    const tasks = [];
    for (const tool of turn) {
        const task = callWorkOf(tool, paths)?.task;
        if (task !== undefined) {
            addOnce(tasks, task);
        }
    }
    return tasks;
}
function addOnce(names, name) {
    if (!names.includes(name)) {
        names.push(name);
    }
}
/** The hand-off work among a turn's calls. */
export function leadTallyOf(turn, paths) {
    let edits = 0;
    let checks = 0;
    let searches = 0;
    let research = 0;
    const edited = [];
    const researched = [];
    for (const tool of turn) {
        const call = callWorkOf(tool, paths);
        switch (call?.work) {
            case 'edit':
                edits += 1;
                addOnce(edited, call.name);
                break;
            case 'check':
                checks += 1;
                break;
            case 'search':
                searches += 1;
                break;
            case 'research':
                research += 1;
                addOnce(researched, call.name);
                break;
            case undefined:
                break;
        }
    }
    return { edits, edited, checks, searches, research, researched };
}
/**
 * The sessions that own the tasks a turn's prompt names, other than the lead: whom the lead's research belongs to.
 * Each once, in the prompt's order, at most `MAX_NAMES`; a task the register does not hold is skipped.
 */
export function taskOwnersOf(ids, tasks, lead) {
    const owners = [];
    for (const id of ids) {
        const owner = tasks.get(id)?.owner;
        if (owner !== undefined && owner !== lead) {
            addOnce(owners, owner);
        }
    }
    return owners.slice(0, MAX_NAMES);
}
/** The research nudge: the owner a team-folder search names, else the owners of the prompt's tasks, else the generic owner. */
function researchLine(call, askOwners) {
    const owners = call.owner === undefined ? askOwners : [call.owner];
    const to = owners.length === 0 ? 'the session that owns it' : owners.join(' or ');
    return `teamrig: the lead did research itself (${call.name}). Send the question to ${to} as a register task with a deadline and relay its answer [leadBoundary].`;
}
/**
 * The line for the lead's model after `current`, once a turn per kind: at its first edit, its first
 * test or build, its first research and its `searchNudgeAt`-th code search (0: never for searches).
 * `turn` includes `current`; `askOwners` are the sessions a research nudge names when the call names none
 * (`taskOwnersOf` the turn's prompt).
 */
export function leadNudgeLine(turn, current, paths, searchNudgeAt, askOwners = []) {
    const tally = leadTallyOf(turn, paths);
    const call = callWorkOf(current, paths);
    switch (call?.work) {
        case 'edit':
            return tally.edits === 1 ? `teamrig: the lead edited ${call.name} itself. ${HAND_OFF}` : undefined;
        case 'check':
            return tally.checks === 1 ? `teamrig: the lead ran a test or a build itself. ${HAND_OFF}` : undefined;
        case 'search':
            return searchNudgeAt > 0 && tally.searches === searchNudgeAt ? `teamrig: the lead made ${searchNudgeAt} code searches itself this turn. ${HAND_OFF}` : undefined;
        case 'research':
            return tally.research === 1 ? researchLine(call, askOwners) : undefined;
        case undefined:
            return undefined;
    }
}
function counted(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}
/** Up to `MAX_NAMES` names, then how many more. */
function namesOf(names) {
    const more = names.length - MAX_NAMES;
    return names.slice(0, MAX_NAMES).join(', ') + (more > 0 ? ` +${more} more` : '');
}
/** The owner's turn-end line when the lead did hand-off work itself; searches count from `searchNudgeAt` (0: never). */
export function leadStopLine(tally, searchNudgeAt) {
    const parts = [
        ...(tally.edits === 0 ? [] : [`${counted(tally.edits, 'edit', 'edits')} (${namesOf(tally.edited)})`]),
        ...(tally.checks === 0 ? [] : [counted(tally.checks, 'test or build', 'tests or builds')]),
        ...(tally.research === 0 ? [] : [`${counted(tally.research, 'research lookup', 'research lookups')} (${namesOf(tally.researched)})`]),
        ...(searchNudgeAt > 0 && tally.searches >= searchNudgeAt ? [counted(tally.searches, 'code search', 'code searches')] : []),
    ];
    return parts.length === 0 ? undefined : `Lead boundary: this turn the lead did ${parts.join(', ')} itself; it delegates such work [leadBoundary].`;
}
