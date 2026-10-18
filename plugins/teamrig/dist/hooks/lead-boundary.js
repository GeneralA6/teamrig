import { basename } from 'node:path';
import { kindOf } from "../budget/patterns.js";
import { programsOf } from "../package-guard/programs.js";
import { EXEC_VALUED, NPM_VALUED } from "../package-guard/runners.js";
import { programName } from "../push-guard/launchers.js";
const SHELLS = new Map([
    ['Bash', 'bash'],
    ['PowerShell', 'powershell'],
]);
/** git subcommands that change a repository. */
const GIT_WRITES = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'revert', 'reset', 'apply', 'am']);
/** git's options before its subcommand that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
/** npm's own test command and its aliases. */
const NPM_TESTS = new Set(['test', 't', 'tst']);
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
/** An npm script that runs tests or a build, such as `test:unit` or `build:dist`. */
const CHECK_SCRIPT = /^(?:test|verify|check|coverage|build|typecheck|lint)(?::[\w:-]+)?$/;
/** Programs that are a test run or a build wherever they start, `npx` included. */
const CHECK_PROGRAMS = new Set(['jest', 'vitest', 'tsc']);
/** node's options whose value is a script it runs. */
const NODE_EVAL = new Set(['-e', '--eval', '-p', '--print']);
/** PowerShell cmdlets that write a file. */
const WRITE_CMDLETS = new Set(['set-content', 'out-file']);
/** An in-place option of sed or perl: `-i`, `-i.bak`, `-pi`, `--in-place`. */
const IN_PLACE = /^-[A-Za-z]*i|^--in-place\b/;
/** A redirection that writes stdout to a file: `>`, `>>`, `>|`, `1>`, `&>`. */
const FILE_WRITE = /^[1&]?>[>|]?$/;
/** A redirection target that is no file: a device such as `/dev/null`, or cmd's `NUL`. */
const DEVICE = /^\/dev\/|^nul$/i;
/** Programs that search files; one that reads a pipe filters output instead. */
const SEARCHES = new Set(['grep', 'rg', 'find', 'select-string']);
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
/** The first word that is not an option, skipping the value of each option in `valued`, with its index. */
function firstOperand(args, valued) {
    let value = false;
    for (const [index, word] of args.entries()) {
        if (!value && (word.dynamic || !word.text.startsWith('-'))) {
            return { word, index };
        }
        value = !value && valued.has(word.text);
    }
    return undefined;
}
/** The first operand's text; undefined when there is none or it is only known when the line runs. */
function operandText(args, valued) {
    const operand = firstOperand(args, valued)?.word;
    return operand === undefined || operand.dynamic ? undefined : operand.text;
}
/** npm: `npm test` (`t`, `tst`), or `npm run` of a test or build script. */
function npmWork(args) {
    const found = firstOperand(args, NPM_VALUED);
    if (found === undefined || found.word.dynamic) {
        return undefined;
    }
    if (NPM_TESTS.has(found.word.text)) {
        return 'check';
    }
    const script = NPM_RUN.has(found.word.text) ? operandText(args.slice(found.index + 1), NPM_VALUED) : undefined;
    return script !== undefined && CHECK_SCRIPT.test(script) ? 'check' : undefined;
}
/** node: `--test` among its options runs tests; an inline script (`-e`, `-p`) that calls `writeFileSync` edits. */
function nodeWork(args) {
    let work;
    let script = false;
    for (const { text } of args) {
        if (script) {
            if (text.includes('writeFileSync')) {
                return 'edit';
            }
            script = false;
            continue;
        }
        if (!text.startsWith('-')) {
            break;
        }
        const equals = text.indexOf('=');
        const option = equals === -1 ? text : text.slice(0, equals);
        if (NODE_EVAL.has(option) && equals !== -1 && text.includes('writeFileSync', equals)) {
            return 'edit';
        }
        script = NODE_EVAL.has(option) && equals === -1;
        work = option === '--test' ? 'check' : work;
    }
    return work;
}
/** The run's stdout goes to a file (one only known when the line runs counts), not to a device. */
function writesFile(run) {
    return run.redirections.some((redirection) => FILE_WRITE.test(redirection.operator) && redirection.target !== undefined && (redirection.target.dynamic || !DEVICE.test(redirection.target.text)));
}
/** What one program a shell call starts does that the lead hands off; undefined for anything else. */
function runWorkOf(run) {
    switch (run.name) {
        case 'git': {
            const subcommand = operandText(run.args, GIT_VALUED);
            if (subcommand !== undefined && GIT_WRITES.has(subcommand)) {
                return 'git';
            }
            return subcommand === 'grep' && !run.piped ? 'search' : undefined;
        }
        case 'cat':
            return writesFile(run) ? 'edit' : undefined;
        case 'sed':
        case 'perl':
            return run.args.some((arg) => !arg.dynamic && IN_PLACE.test(arg.text)) ? 'edit' : undefined;
        case 'patch':
            return 'edit';
        case 'npm':
            return npmWork(run.args);
        case 'npx': {
            const bin = operandText(run.args, EXEC_VALUED);
            return bin !== undefined && CHECK_PROGRAMS.has(programName(bin)) ? 'check' : undefined;
        }
        case 'node':
            return nodeWork(run.args);
        default:
            if (WRITE_CMDLETS.has(run.name)) {
                return 'edit';
            }
            if (CHECK_PROGRAMS.has(run.name)) {
                return 'check';
            }
            return SEARCHES.has(run.name) && run.args.length > 0 && !run.piped ? 'search' : undefined;
    }
}
/** A shell call by the programs it starts: an edit before a test or build before a search; a line naming the lead's own files is its job. */
function shellWorkOf(command, dialect, own) {
    const works = new Set(programsOf(command, { cwd: undefined, home: own.home, dialect }).map(runWorkOf));
    if (works.has('git') || works.has('edit')) {
        return own.named(command) ? undefined : { work: 'edit', name: works.has('git') ? 'git' : 'shell' };
    }
    if (works.has('check')) {
        return { work: 'check', name: 'shell' };
    }
    return works.has('search') && !own.named(command) ? { work: 'search', name: 'shell' } : undefined;
}
function callWorkOf(tool, own) {
    const dialect = SHELLS.get(tool.name);
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
