import { Buffer } from 'node:buffer';
import { assignedWords, isExpressionHead, parseShell } from "./tokenizer.js";
const WRAPPERS = new Map([
    ['command', { inspect: ['-v', '-V'] }],
    ['builtin', {}],
    ['exec', { valued: ['-a'] }],
    ['nohup', {}],
    ['setsid', {}],
    ['busybox', {}],
    ['unbuffer', {}],
    ['chronic', {}],
    ['noglob', {}],
    ['nocorrect', {}],
    ['call', {}],
    ['time', { valued: ['-o', '-f', '--output', '--format'] }],
    ['nice', { valued: ['-n', '--adjustment'] }],
    ['ionice', { valued: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'] }],
    ['env', { valued: ['-u', '--unset', '-a', '--argv0'], chdir: ['-C', '--chdir'], split: ['-S', '--split-string'], assignments: true }],
    [
        'sudo',
        {
            valued: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--close-from', '--role', '--type', '--other-user', '--command-timeout'],
            chdir: ['-D', '--chdir'],
            inspect: ['-l', '--list', '-e', '--edit', '-V', '--version', '-K', '--remove-timestamp', '-v', '--validate', '--help'],
            assignments: true,
        },
    ],
    ['doas', { valued: ['-u', '-C'] }],
    ['timeout', { valued: ['-s', '-k', '--signal', '--kill-after'], leading: 1 }],
    ['stdbuf', { valued: ['-i', '-o', '-e', '--input', '--output', '--error'] }],
    [
        'xargs',
        {
            valued: ['-a', '-E', '-I', '-L', '-n', '-P', '-s', '-d', '--arg-file', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--process-slot-var'],
            stdinArgs: true,
        },
    ],
    ['wsl', { valued: ['-d', '--distribution', '-u', '--user', '--shell-type', '--distribution-id'], chdir: ['--cd'] }],
]);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['pwsh', 'powershell', 'pwsh-preview']);
/** Bash options that take the next word as their value. */
const POSIX_SHELL_VALUED = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const BASH_SKIPPED = new Set(['!', '{', '}', 'then', 'else', 'elif', 'do', 'if', 'while', 'until', 'coproc']);
/** Keywords whose words are data, not a program: `for x in a b`, `case $x in`, or a block's end. */
const BASH_DATA = new Set(['for', 'select', 'case', 'fi', 'done', 'esac']);
const PS_SKIPPED = new Set(['if', 'elseif', 'else', 'while', 'do', 'until', 'try', 'finally', 'begin', 'process', 'end', 'clean', 'dynamicparam', 'return', 'throw', 'trap']);
const PS_DATA = new Set(['foreach', 'for', 'switch', 'param', 'catch', 'data', 'class', 'enum', 'using', 'exit', 'break', 'continue']);
/** Keywords followed by a name that is not a program: `function deploy`. */
const NAMED_BLOCKS = new Set(['function', 'filter', 'workflow', 'configuration']);
const CMD_SKIPPED = new Set(['do', 'else']);
const CMD_DATA = new Set(['for', 'rem', 'goto', 'set']);
const CMD_IF_TESTS = new Set(['exist', 'defined', 'errorlevel', 'cmdextversion']);
const CMD_IF_OPERATORS = new Set(['==', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq']);
/** `pwsh` / `powershell` options that take the next word as their value, by full name, and their short aliases. */
const PS_VALUED_NAMES = ['executionpolicy', 'inputformat', 'outputformat', 'windowstyle', 'version', 'configurationname', 'configurationfile', 'custompipename', 'settingsfile', 'psconsolefile'];
const PS_VALUED_ALIASES = new Set(['ex', 'ep', 'if', 'inp', 'of', 'o', 'w', 'v', 'config', 'settings']);
/** `Start-Process` parameters, by full name, with their aliases. */
const START_PROCESS_PARAMETERS = new Map([
    ['filepath', ['path', 'pspath']],
    ['argumentlist', ['args']],
    ['workingdirectory', []],
    ['credential', []],
    ['redirectstandarderror', ['rse']],
    ['redirectstandardinput', ['rsi']],
    ['redirectstandardoutput', ['rso']],
    ['windowstyle', []],
    ['verb', []],
    ['environment', []],
    ['loaduserprofile', ['lup']],
    ['nonewwindow', ['nnw']],
    ['passthru', []],
    ['wait', []],
    ['usenewenvironment', []],
]);
const START_PROCESS_FLAGS = new Set(['loaduserprofile', 'nonewwindow', 'passthru', 'wait', 'usenewenvironment']);
/** `start` options in cmd that take the next word as their value. */
const CMD_START_VALUED = new Set(['/node', '/affinity', '/machine']);
/**
 * teamrig's subcommands that run the command line after their `--`: `teamrig queue ... -- git push`. `heavy`, the old
 * name of `queue` (T1308), stays: teamrig refuses it now, but the week's transcripts the budget reads for misses still
 * hold it, and an older teamrig on the path would still run what it wraps, so the guards keep reading that command.
 */
const TEAMRIG_RUNNERS = new Set(['queue', 'heavy', 'test']);
/** The shell Node's `spawn` starts with `shell: true`, which runs a teamrig runner's command given as one word. */
const SPAWN_SHELL = process.platform === 'win32' ? 'cmd' : 'bash';
/** How many wrappers deep one command may go before the guard stops reading it. */
const MAX_STEPS = 16;
const NOTHING = { kind: 'nothing' };
const STDIN_SCRIPT = { kind: 'opaque', reason: 'a shell reads its commands from stdin', gated: true, stdinScript: true };
/** A word whose text is known. */
export function staticWord(text) {
    return { text, dynamic: false };
}
/** The program a word names, as the guard compares it: the file name, lower case, without `.exe`, `.cmd`, `.bat` or `.com`. */
export function programName(text) {
    const base = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1).toLowerCase();
    return base.replace(/\.(?:exe|cmd|bat|com)$/, '');
}
/** Whether a word names a shell. */
export function isShell(text) {
    const name = programName(text);
    return POSIX_SHELLS.has(name) || POWERSHELLS.has(name);
}
/** True for a bash `NAME=value` word. */
export function isAssignment(text) {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}
function assignmentOf(word) {
    const equals = word.text.indexOf('=');
    return { name: word.text.slice(0, equals), value: { text: word.text.slice(equals + 1), dynamic: word.dynamic } };
}
/** Joins words into one command line; for cmd a word with spaces or separators is quoted, as the caller's process start would. */
function joinWords(words, quote) {
    const text = words.map((word) => (quote && words.length > 1 && /[\s&|<>()^]/.test(word.text) ? `"${word.text}"` : word.text)).join(' ');
    return { text, dynamic: words.some((word) => word.dynamic) };
}
/**
 * Reads what one simple command starts, seeing through keywords (`if`, `do`, `then`), environment prefixes,
 * wrappers (`command`, `env`, `sudo`, `nohup`, `timeout`, `xargs`, `wsl`, ...), the PowerShell call operator
 * and `Start-Process`, shells handed a command line (`bash -c`, `pwsh -Command` or `-EncodedCommand`,
 * `cmd /c`, `eval`, `Invoke-Expression`) and teamrig's runners (`teamrig queue -- ...`). One reader per command, since it collects that command's
 * environment and folders.
 */
class LaunchReader {
    env = [];
    chdirs = [];
    dialect;
    /** What the command reads on stdin from the line itself: a heredoc's body or a here-string. */
    stdin;
    stdinArgs = false;
    /** True once a word is known to name a program, so PowerShell cannot read it as an expression. */
    called = false;
    /** True once a teamrig runner is read: what it starts runs under the host lock. */
    runner = false;
    /** True once a PowerShell assignment is read: its right side's output goes into a variable. */
    captured = false;
    constructor(dialect, stdin) {
        this.dialect = dialect;
        this.stdin = stdin;
    }
    read(words) {
        let rest = words;
        for (let step = 0; step < MAX_STEPS; step += 1) {
            const next = this.step(rest);
            if (next.kind !== 'next') {
                return next;
            }
            rest = next.words;
        }
        return { kind: 'opaque', reason: 'wrappers nest too deep to read', gated: true };
    }
    step(words) {
        const head = words[0];
        if (head === undefined) {
            return NOTHING;
        }
        if (!head.dynamic && !this.called) {
            const keyword = this.keyword(words, head.text);
            if (keyword !== undefined) {
                return keyword;
            }
        }
        if (this.dialect === 'bash' && isAssignment(head.text)) {
            this.env.push(assignmentOf(head));
            return { kind: 'next', words: words.slice(1) };
        }
        if (this.dialect === 'powershell' && !head.dynamic && (head.text === '&' || head.text === '.') && !this.called) {
            this.called = true;
            return { kind: 'next', words: words.slice(1) };
        }
        if (head.dynamic || (this.dialect === 'powershell' && !this.called && isExpressionHead(head))) {
            return this.dynamicHead(words, head);
        }
        return this.named(programName(head.text), words.slice(1), head);
    }
    /** A keyword at a command's start: skipped, a line of data, or a named block. */
    keyword(words, text) {
        const lower = this.dialect === 'bash' ? text : text.toLowerCase();
        if (NAMED_BLOCKS.has(lower) && this.dialect !== 'cmd') {
            return { kind: 'next', words: words.slice(2) };
        }
        switch (this.dialect) {
            case 'bash':
                return BASH_SKIPPED.has(lower) ? { kind: 'next', words: words.slice(1) } : BASH_DATA.has(lower) ? NOTHING : undefined;
            case 'powershell':
                return PS_SKIPPED.has(lower) ? { kind: 'next', words: words.slice(1) } : PS_DATA.has(lower) ? NOTHING : undefined;
            case 'cmd':
                if (lower === 'if') {
                    return cmdIf(words.slice(1));
                }
                return CMD_SKIPPED.has(lower) ? { kind: 'next', words: words.slice(1) } : CMD_DATA.has(lower) ? NOTHING : undefined;
        }
    }
    /**
     * A first word only known when it runs. In PowerShell it is an expression unless it was called: an
     * assignment (`$x = git push`, `$h.a = git push`, `$p, $q = git push`) runs its right side.
     */
    dynamicHead(words, head) {
        if (this.dialect !== 'powershell' || this.called) {
            return { kind: 'opaque', reason: 'the program it runs is only known when it runs', gated: true, command: { program: head, args: words.slice(1) } };
        }
        const right = assignedWords(words);
        if (right === undefined) {
            return NOTHING;
        }
        this.captured = true;
        return { kind: 'next', words: right };
    }
    named(name, args, head) {
        const wrapper = WRAPPERS.get(name);
        if (wrapper !== undefined) {
            this.called = true;
            return this.wrapper(wrapper, args);
        }
        if (POSIX_SHELLS.has(name)) {
            return this.posixShell(args);
        }
        if (POWERSHELLS.has(name)) {
            return this.powerShell(name, args);
        }
        if (name === 'cmd') {
            return this.cmd(args);
        }
        if (name === 'eval' && this.dialect === 'bash') {
            return args.length === 0 ? NOTHING : this.script(joinWords(args, false), 'bash', true);
        }
        if ((name === 'invoke-expression' || name === 'iex') && this.dialect === 'powershell') {
            const script = args.find((arg) => !arg.text.startsWith('-'));
            // With no script of its own it runs what the pipeline hands it: `'...' | iex`.
            return script === undefined ? this.fromStdin('powershell') : this.script(script, 'powershell', true);
        }
        if (this.dialect === 'powershell' && (name === 'start-process' || name === 'saps' || name === 'start')) {
            return this.startProcess(args);
        }
        if (this.dialect !== 'powershell' && name === 'start') {
            return this.cmdStart(args);
        }
        if (name === 'teamrig') {
            return this.teamrig(args, head);
        }
        return { kind: 'program', program: head, args, env: this.env, chdirs: this.chdirs, stdinArgs: this.stdinArgs, runner: this.runner, captured: this.captured };
    }
    script(script, dialect, sameShell) {
        return { kind: 'script', script, dialect, sameShell, env: this.env, chdirs: this.chdirs, runner: this.runner, captured: this.captured };
    }
    /**
     * A shell that reads its commands from stdin runs the heredoc or here-string the line gives it, in a shell
     * of its own. Without one, or under `xargs`, which feeds stdin to the arguments, the commands are unknown.
     */
    fromStdin(dialect) {
        return this.stdin === undefined || this.stdinArgs ? STDIN_SCRIPT : this.script(this.stdin, dialect, false);
    }
    /** Reads a wrapper's options, getopt style, and returns the words of the program it runs. */
    wrapper(spec, args) {
        this.stdinArgs ||= spec.stdinArgs === true;
        const has = (list, option) => list?.includes(option) === true;
        const takesValue = (option) => has(spec.valued, option) || has(spec.chdir, option) || has(spec.split, option);
        let leading = spec.leading ?? 0;
        let index = 0;
        for (; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            const text = word.text;
            if (text === '--') {
                index += 1;
                break;
            }
            let option;
            let value;
            if (/^--[^-]/.test(text)) {
                const equals = text.indexOf('=');
                option = equals === -1 ? text : text.slice(0, equals);
                if (takesValue(option)) {
                    value = equals === -1 ? args[(index += 1)] : { text: text.slice(equals + 1), dynamic: word.dynamic };
                }
            }
            else if (text.startsWith('-')) {
                for (let at = 1; at < text.length; at += 1) {
                    const short = `-${text.charAt(at)}`;
                    if (has(spec.inspect, short)) {
                        return NOTHING;
                    }
                    if (takesValue(short)) {
                        option = short;
                        value = at + 1 < text.length ? { text: text.slice(at + 1), dynamic: word.dynamic } : args[(index += 1)];
                        break;
                    }
                }
            }
            else if (spec.assignments === true && isAssignment(text)) {
                this.env.push(assignmentOf(word));
                continue;
            }
            else if (leading > 0) {
                leading -= 1;
                continue;
            }
            else {
                break;
            }
            if (option !== undefined && has(spec.inspect, option)) {
                return NOTHING;
            }
            if (option !== undefined && value !== undefined && has(spec.chdir, option)) {
                this.chdirs.push(value);
            }
            if (option !== undefined && value !== undefined && has(spec.split, option)) {
                if (value.dynamic) {
                    return { kind: 'opaque', reason: 'env -S splits a command line only known when it runs', gated: true };
                }
                const split = parseShell(value.text, 'bash').commands.flatMap((command) => command.words);
                return { kind: 'next', words: [...split, ...args.slice(index + 1)] };
            }
        }
        return { kind: 'next', words: args.slice(index + leading) };
    }
    /** `sh`, `bash`, `zsh`, ...: `-c` runs the first operand as a script; with no operand, or `-s`, they read stdin; otherwise they run a script file. */
    posixShell(args) {
        let command = false;
        let stdin = false;
        let index = 0;
        for (; index < args.length; index += 1) {
            const text = args[index]?.text ?? '';
            if (text === '--' || text === '-') {
                index += 1;
                break;
            }
            if (POSIX_SHELL_VALUED.has(text)) {
                index += 1;
            }
            else if (/^[-+][A-Za-z]+$/.test(text)) {
                command ||= text.startsWith('-') && text.includes('c');
                stdin ||= text.startsWith('-') && text.includes('s');
            }
            else if (!text.startsWith('--')) {
                break;
            }
        }
        const operand = args[index];
        if (command) {
            return operand === undefined ? NOTHING : this.script(operand, 'bash', false);
        }
        return operand === undefined || stdin ? this.fromStdin('bash') : NOTHING;
    }
    /**
     * `pwsh` and `powershell`: `-Command` runs the rest of the line, `-EncodedCommand` a base64 UTF-16LE script,
     * `-File` a script file; a first operand is a command for Windows PowerShell and a file for pwsh. Options
     * may be abbreviated and start with `-`, `--` or `/`.
     */
    powerShell(name, args) {
        for (let index = 0; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            if (word.text === '-') {
                return this.fromStdin('powershell');
            }
            const option = powerShellOption(word.text);
            if (option === undefined) {
                return name === 'powershell' ? this.script(joinWords(args.slice(index), false), 'powershell', false) : NOTHING;
            }
            const value = args[index + 1];
            switch (option) {
                case 'command': {
                    const rest = args.slice(index + 1);
                    return rest[0]?.text === '-' ? this.fromStdin('powershell') : rest.length === 0 ? NOTHING : this.script(joinWords(rest, false), 'powershell', false);
                }
                case 'encoded':
                    return value === undefined ? NOTHING : this.encoded(value);
                case 'file':
                    return value?.text === '-' ? this.fromStdin('powershell') : NOTHING;
                case 'chdir':
                    if (value !== undefined) {
                        this.chdirs.push(value);
                    }
                    index += 1;
                    break;
                case 'valued':
                    index += 1;
                    break;
                case 'flag':
                    break;
            }
        }
        return this.fromStdin('powershell');
    }
    encoded(value) {
        if (value.dynamic || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.text)) {
            return { kind: 'opaque', reason: 'an encoded PowerShell command cannot be read', gated: false };
        }
        return this.script(staticWord(Buffer.from(value.text, 'base64').toString('utf16le')), 'powershell', false);
    }
    /** `cmd /c` and `/k` run the rest of the line (`//c` from Git Bash, or attached: `/cgit`); otherwise cmd reads stdin. */
    cmd(args) {
        for (let index = 0; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            const run = /^\/\/?[ck](.*)$/is.exec(word.text);
            if (run !== null) {
                const attached = run[1] ?? '';
                const rest = [...(attached === '' ? [] : [{ text: attached, dynamic: word.dynamic }]), ...args.slice(index + 1)];
                return rest.length === 0 ? NOTHING : this.script(joinWords(rest, true), 'cmd', false);
            }
            if (!word.text.startsWith('/')) {
                break;
            }
        }
        return this.fromStdin('cmd');
    }
    /** PowerShell's `Start-Process`: the program is `-FilePath` (or the first operand) with its `-ArgumentList` (or the second). */
    startProcess(args) {
        let program;
        const programArgs = [];
        let listing = false;
        for (let index = 0; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            const parameter = word.dynamic ? undefined : startProcessParameter(word.text);
            if (parameter === undefined) {
                if (!listing && program === undefined) {
                    program = word;
                }
                else {
                    programArgs.push(word);
                }
            }
            else if (parameter === 'argumentlist') {
                listing = true;
            }
            else if (parameter === 'filepath') {
                program = args[(index += 1)];
            }
            else if (parameter === 'workingdirectory') {
                const value = args[(index += 1)];
                if (value !== undefined) {
                    this.chdirs.push(value);
                }
            }
            else if (!START_PROCESS_FLAGS.has(parameter)) {
                index += 1;
            }
        }
        if (program === undefined) {
            return NOTHING;
        }
        this.called = true;
        // The program splits this text itself, on a space or a tab: a wider split could fake a word such as `--verify`.
        const split = programArgs.flatMap((arg) => (arg.dynamic ? [arg] : arg.text.split(/[ \t]+/).filter((part) => part !== '').map(staticWord)));
        return { kind: 'next', words: [program, ...split] };
    }
    /** cmd's `start`: options start with `/`, `/D` names the folder, and a first operand with spaces (or empty) is the window title. */
    cmdStart(args) {
        let index = 0;
        let titled = false;
        for (; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            const lower = word.text.toLowerCase();
            if (lower === '/d') {
                const value = args[(index += 1)];
                if (value !== undefined) {
                    this.chdirs.push(value);
                }
            }
            else if (lower.startsWith('/d') && lower.length > 2) {
                this.chdirs.push({ text: word.text.slice(2), dynamic: word.dynamic });
            }
            else if (CMD_START_VALUED.has(lower)) {
                index += 1;
            }
            else if (!lower.startsWith('/')) {
                if (titled || (word.text !== '' && !/\s/.test(word.text))) {
                    break;
                }
                titled = true;
            }
        }
        this.called = true;
        return { kind: 'next', words: args.slice(index) };
    }
    /**
     * `teamrig queue` and `teamrig test` run the words after their first `--` as `commandLine` (test-run/shell.ts)
     * joins them: one word as a command line for the shell `spawn` starts, several as a program and its arguments.
     * What they start is marked `runner`. Any other subcommand is teamrig itself. A subcommand only known when it runs
     * may be a runner, so the command is opaque; it keeps its words for the exec guard, as it may be `exec approve`.
     */
    teamrig(args, head) {
        const [subcommand] = args;
        if (subcommand?.dynamic === true) {
            return { kind: 'opaque', reason: 'the teamrig subcommand it runs is only known when it runs', gated: true, command: { program: head, args } };
        }
        const end = args.findIndex((arg) => !arg.dynamic && arg.text === '--');
        if (subcommand === undefined || !TEAMRIG_RUNNERS.has(subcommand.text) || end === -1) {
            return { kind: 'program', program: head, args, env: this.env, chdirs: this.chdirs, stdinArgs: this.stdinArgs, runner: this.runner, captured: this.captured };
        }
        const words = args.slice(end + 1);
        const [only] = words;
        if (only === undefined) {
            return NOTHING;
        }
        this.runner = true;
        if (words.length === 1) {
            return this.script(only, SPAWN_SHELL, false);
        }
        this.called = true;
        return { kind: 'next', words };
    }
}
/** cmd's `if [/i] [not] exist X command`, `if a==b command`, `if a EQU b command`: the words of the command it runs. */
function cmdIf(words) {
    let rest = words;
    for (const prefix of ['/i', 'not']) {
        if (rest[0]?.text.toLowerCase() === prefix) {
            rest = rest.slice(1);
        }
    }
    const first = rest[0]?.text ?? '';
    const second = rest[1]?.text ?? '';
    let skip;
    if (CMD_IF_TESTS.has(first.toLowerCase())) {
        skip = 2;
    }
    else if (first.includes('==') && !first.startsWith('==') && !first.endsWith('==')) {
        skip = 1;
    }
    else if (first.endsWith('==') || (second.startsWith('==') && second !== '==')) {
        skip = 2;
    }
    else if (CMD_IF_OPERATORS.has(second.toLowerCase())) {
        skip = 3;
    }
    else {
        return NOTHING;
    }
    return { kind: 'next', words: rest.slice(skip) };
}
/** Classifies a `pwsh` / `powershell` option, which may be abbreviated; undefined for an operand. */
function powerShellOption(text) {
    const match = /^(?:--?|\/)([A-Za-z][\w-]*)$/.exec(text);
    if (match === null) {
        return undefined;
    }
    const option = (match[1] ?? '').toLowerCase();
    const abbreviates = (name, minimum) => option.length >= minimum && name.startsWith(option);
    if (option === 'c' || option === 'cwa' || abbreviates('command', 3) || abbreviates('commandwithargs', 8)) {
        return 'command';
    }
    if (option === 'e' || option === 'ec' || abbreviates('encodedcommand', 2)) {
        return 'encoded';
    }
    if (option === 'f' || abbreviates('file', 2)) {
        return 'file';
    }
    if (option === 'wd' || abbreviates('workingdirectory', 2)) {
        return 'chdir';
    }
    if (PS_VALUED_ALIASES.has(option) || PS_VALUED_NAMES.some((name) => abbreviates(name, 3))) {
        return 'valued';
    }
    return 'flag';
}
/** The `Start-Process` parameter a word names, by alias or an unambiguous abbreviation of three or more letters. */
function startProcessParameter(text) {
    const match = /^-([A-Za-z]+)$/.exec(text);
    if (match === null) {
        return undefined;
    }
    const option = (match[1] ?? '').toLowerCase();
    const found = [...START_PROCESS_PARAMETERS].filter(([name, aliases]) => name === option || aliases.includes(option) || (option.length >= 3 && name.startsWith(option)));
    return found.length === 1 ? found[0]?.[0] : undefined;
}
/** What one simple command starts, given what it reads on stdin from the line, if anything; see {@link LaunchReader}. */
export function launch(words, dialect, stdin) {
    return new LaunchReader(dialect, stdin).read(words);
}
