import { isAbsolute, join } from 'node:path';
import { interpreterDoubt, interpreterLanguage, interpreterOf, interpreterText, readScriptFile, scriptMayPush } from "./interpreters.js";
import { isAssignment, isShell, launch, programName, staticWord } from "./launchers.js";
import { Location, resolveDir } from "./location.js";
import { splitGitAlias } from "./program-split.js";
import { redirectsInput, stdinUse } from "./stdin.js";
import { parseHeldText, parseShell } from "./tokenizer.js";
import { resolveLiteralVariables } from "./variables.js";
/** Git's own commands; an alias never overrides one. */
const BUILTINS = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap ' +
    'check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config ' +
    'count-objects credential cvsexportcommit cvsimport cvsserver daemon describe diagnose diff diff-files diff-index diff-tree ' +
    'difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc ' +
    'get-tar-commit-id gitk grep gui hash-object help hook http-backend http-fetch http-push imap-send index-pack init instaweb ' +
    'interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index ' +
    'merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id prune ' +
    'prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote repack replace replay ' +
    'request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email send-pack shortlog show show-branch show-index ' +
    'show-ref sparse-checkout stage stash status stripspace submodule subtree svn switch symbolic-ref tag unpack-file unpack-objects ' +
    'update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version ' +
    'whatchanged worktree write-tree').split(' '));
/** Git options that only print something and run no command. */
const GIT_INFO_OPTIONS = new Set(['--help', '-h', '--version', '-v', '--html-path', '--man-path', '--info-path', '--exec-path']);
/** Git options that take a value, as the next word or after `=`. */
const GIT_VALUED_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);
/** Config sections that change which remote branch a push updates. */
const PUSH_CONFIG = /^(?:remote|push|branch)\./i;
/** `git config` forms that read or remove, never set. */
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--remove-section', '--rename-section', '-e', '--edit']);
/** `git config` options that unset the key they name. */
const CONFIG_UNSETS = new Set(['--unset', '--unset-all']);
const CONFIG_VALUED = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'unset', 'edit', 'rename-section', 'remove-section']);
const FILTER_OPTIONS = new Set(['--setup', '--env-filter', '--tree-filter', '--index-filter', '--msg-filter', '--commit-filter', '--parent-filter', '--tag-name-filter']);
/** How deep scripts (`bash -c "eval ..."`) and git aliases may nest before the guard stops reading. */
const MAX_SCRIPT_DEPTH = 8;
/**
 * Bash builtins that read a word's text again as code, or as a name whose subscript bash
 * evaluates (`read 'a[$(x)]'`, `unset`, `declare`, `let`, `test -v`), and `eval` / `source` / `.`, which run it.
 * Only the program a command runs counts: as an argument (`git add .`, `grep eval notes.md`) the word is data.
 */
const REREADERS = new Set([
    ...['eval', 'source', '.', 'let', 'read', 'readarray', 'mapfile', 'getopts', 'unset', 'wait', 'test', '[', '[['],
    ...['declare', 'typeset', 'local', 'export', 'readonly', 'trap', 'fc', 'alias'],
]);
/**
 * The wrappers whose words come before the program they run (see launchers.ts WRAPPERS); a
 * shell or re-reader after one is still in command position: `sudo bash f.sh`, `timeout 5 bash f.sh`.
 */
const COMMAND_WRAPPERS = new Set(['env', 'nice', 'timeout', 'command', 'builtin', 'exec', 'sudo', 'nohup', 'time', 'stdbuf', 'ionice', 'setsid', 'xargs', 'doas']);
/** An expansion in a word that reads a value again as code: `${!x}`, `${x@P}`, `$(( ))`. */
const REREADING_EXPANSION = /\$\{!|@P\}|\$\(\(/;
/** An arithmetic command `(( ))` where a command starts. */
const ARITHMETIC_COMMAND = /(?:^|[;&|(\n{]|\b(?:then|else|do|elif|if|while|until)\b)\s*\(\(/;
/** An assignment word, its name maybe subscripted: `x=`, `x+=`, `a[i]=`. */
const ASSIGNMENT_WORD = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
/** A redirection that writes a file: `>`, `>>`, `>|`, `2>`, `&>`, `&>>`. */
const WRITES_FILE = /^(?:\d*|&)>[>|]?$/;
/**
 * The program names in command position of `words`: the first word after assignments, and
 * through each wrapper (with its options and a `timeout` duration) the word it runs.
 */
function commandNames(words) {
    const names = [];
    let wrapped = false;
    for (const word of words) {
        if (ASSIGNMENT_WORD.test(word.text) || (wrapped && (word.text.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(word.text)))) {
            continue;
        }
        const name = word.dynamic ? '' : programName(word.text);
        names.push(name);
        wrapped = COMMAND_WRAPPERS.has(name);
        if (!wrapped) {
            break;
        }
    }
    return names;
}
/*
 * Shell script files. A shell that runs a script file (`bash x.sh`,
 * `sh x.sh`, `source x.sh`, `. x.sh`) or a text file run by its path (`./x.sh`) runs its lines as commands, so the
 * guard reads the file and judges them as it judges the line. A file the line itself writes is read as the line
 * writes it (a heredoc `cat` stores), never from the disk the line is about to overwrite; one whose text the guard
 * cannot know, or a script file it cannot read or name, is a doubt.
 */
/** A script's first line naming the program that runs it, and `env`'s program after it. */
const SHEBANG = /^#!\s*(\S+)(?:[ \t]+(\S+))?/;
/** A path into a device or process folder, which no command writes as a script. */
const DEVICE_PATH = /^\/(?:dev|proc)\//;
/** A file name a shell script has. */
const SHELL_SCRIPT_NAME = /\.(?:sh|bash)$/i;
/**
 * True when a program name is git, or one of git's own commands (`git-push`, as in git's exec path), which the
 * finder reads as git; any other `git-*` file run by its path (`./git-ship.sh`) is a script like any other.
 */
function isGitProgram(name) {
    return name === 'git' || (name.startsWith('git-') && BUILTINS.has(name.slice(4)));
}
/** The bytes of a script's start that bash samples to tell a binary file. */
const BINARY_SAMPLE = 80;
/**
 * True when bash refuses to run `text` as a binary file: a NUL byte before
 * the first newline within its first {@link BINARY_SAMPLE} bytes. The text is measured as UTF-8 again, which is never
 * shorter than the bytes it was read from, so a NUL past byte 80 is never taken for one inside it.
 */
function looksBinary(text) {
    const sample = Buffer.from(text, 'utf8').subarray(0, BINARY_SAMPLE);
    const newline = sample.indexOf(0x0a);
    return (newline === -1 ? sample : sample.subarray(0, newline)).includes(0);
}
/*
 * Programs that run a command the guard cannot read: on another host
 * or in a container, in a terminal or multiplexer, later, or in parallel. Each is a doubt when the command it is
 * handed names a push: in its arguments, or for those that read commands on stdin, in its stdin (a heredoc or a
 * here-string), or a pipe into it when the line names a push.
 */
/** Programs that run a command from their arguments. */
const ARGUMENT_RUNNERS = new Set([
    ...['ssh', 'watch', 'tmux', 'screen', 'xterm', 'gnome-terminal', 'konsole', 'kitty', 'alacritty', 'xfce4-terminal', 'parallel'],
    ...['docker', 'podman', 'kubectl', 'oc', 'awk', 'gawk', 'mawk', 'nawk'],
    // Containers, multiplexers and programs with a command option.
    ...['nerdctl', 'toolbox', 'distrobox', 'byobu', 'zellij', 'expect', 'vim', 'nvim', 'vi', 'ex', 'gdb', 'machinectl'],
]);
/** Container tools: only what follows their `exec`, `run` or `debug` is a command (`docker push` pushes an image). */
const CONTAINER_TOOLS = new Set(['docker', 'podman', 'kubectl', 'oc', 'nerdctl']);
/**
 * Programs that run commands only through an option's value, by the
 * options that hold one: an editor's `-c` / `+` (`vim -c '!git push'`), gdb's `-ex`, expect's `-c`.
 */
const COMMAND_OPTIONS = new Map([
    ...['vim', 'nvim', 'vi', 'ex'].map((name) => [name, new Set(['-c', '--cmd'])]),
    ['gdb', new Set(['-ex', '--ex', '-iex', '--iex', '--eval-command', '--init-eval-command', '-eval-command', '-init-eval-command'])],
    ['expect', new Set(['-c'])],
]);
const CONTAINER_COMMANDS = new Set(['exec', 'run', 'debug']);
/** awk runs a command only through `system(...)` or a pipe to or from a quoted command. */
const AWK_RUNS = /system\s*\(|\|\s*"|"\s*\|/;
/** The arguments of an {@link ARGUMENT_RUNNERS} program that hold the command it runs. */
function runnerArgs(name, args) {
    if (CONTAINER_TOOLS.has(name)) {
        const at = args.findIndex((arg) => CONTAINER_COMMANDS.has(arg.text));
        return at === -1 ? [] : args.slice(at + 1);
    }
    if (/awk$/.test(name)) {
        return args.filter((arg) => AWK_RUNS.test(arg.text));
    }
    const options = COMMAND_OPTIONS.get(name);
    if (options !== undefined) {
        // The value after a command option, or joined to it with `=` (`-ex=...`, `--eval-command=...`; gdb reads
        // long options with one dash too), and a vim `+command`.
        return args.filter((arg, at) => options.has(args[at - 1]?.text ?? '') || arg.text.startsWith('+') || [...options].some((option) => arg.text.startsWith(`${option}=`)));
    }
    return args;
}
/**
 * Programs that hand their command words, joined, to a shell, so the
 * shell reads them as a command line (`ssh host 'git p\\ush'` runs a push). Each maps to the options that take a
 * value before the command; `tmux` reads them after the subcommands that start a shell command.
 */
const JOINED_RUNNERS = new Map([
    ['ssh', new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])],
    ['watch', new Set(['-n', '--interval', '-q', '--equexit'])],
    ['tmux', new Set()],
]);
/** tmux's global options that take a value, before its subcommand; `-c` is a shell command it runs. */
const TMUX_GLOBAL_VALUED = new Set(['-c', '-f', '-L', '-S', '-T']);
const TMUX_NEW_VALUED = ['-c', '-e', '-F', '-n', '-s', '-t', '-x', '-y', '-f', '-l'];
/**
 * tmux subcommands whose last words a shell runs, by the options of each that take a value (`send-keys` types its
 * words into a shell, `if-shell` also runs tmux commands, read as shell too).
 */
const TMUX_SHELL_COMMANDS = new Map([
    ...['new-session', 'new', 'new-window', 'neww', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw'].map((name) => [name, new Set(TMUX_NEW_VALUED)]),
    ...['split-window', 'splitw'].map((name) => [name, new Set(['-c', '-e', '-F', '-l', '-t', '-p'])]),
    ...['run-shell', 'run'].map((name) => [name, new Set(['-c', '-d', '-t'])]),
    ...['if-shell', 'if', 'pipe-pane', 'pipep'].map((name) => [name, new Set(['-t'])]),
    ...['display-popup', 'popup'].map((name) => [name, new Set(['-b', '-c', '-d', '-e', '-h', '-s', '-S', '-t', '-T', '-w', '-x', '-y'])]),
    ...['send-keys', 'send'].map((name) => [name, new Set(['-N', '-t'])]),
]);
/** Screen's options that take a value, and those that start nothing. */
const SCREEN_VALUED = new Set(['-S', '-t', '-c', '-e', '-h', '-p', '-T', '-s', '-Logfile']);
const SCREEN_SESSION_OPTIONS = new Set(['-X', '-x', '-r', '-R', '-RR', '-ls', '-list', '-wipe', '-Q']);
/**
 * What a cluster of short `screen` options (`-dmS n`) does. `valued`
 * when its last letter takes the next word as its value, `session` when a letter talks to a session and starts
 * nothing, `flags` otherwise. A valued letter with text after it (`-dmSn`) holds its value itself.
 */
function screenCluster(text) {
    if (!/^-[A-Za-z]{2,}$/.test(text)) {
        return 'flags';
    }
    for (let at = 1; at < text.length; at += 1) {
        const letter = text[at] ?? '';
        if (SCREEN_SESSION_OPTIONS.has(`-${letter}`)) {
            return 'session';
        }
        if (SCREEN_VALUED.has(`-${letter}`)) {
            return at === text.length - 1 ? 'valued' : 'flags';
        }
    }
    return 'flags';
}
/** Builtins that set and export a variable, as `export` does. */
const EXPORTING_PROGRAMS = new Set(['export', 'env', 'declare', 'typeset', 'local', 'readonly', 'sudo', 'doas']);
/** A bash option naming a startup file an interactive shell runs: `--rcfile f`, `--init-file f`. */
const RC_FILE_OPTION = /^--(?:rcfile|init-file)(?:=(.*))?$/;
/** Ssh options whose value a local or remote shell runs. */
const SSH_COMMAND_OPTION = /^(?:ProxyCommand|RemoteCommand|LocalCommand|KnownHostsCommand)[=\s]+(.+)$/is;
/** Programs that read a `<` file as commands: shells and stdin runners. */
const FILE_STDIN_READERS = /^(?:sh|bash|dash|zsh|ksh|mksh|ash|su|runuser|sudo|doas|ssh|at|batch|crontab|parallel|make|docker|podman|kubectl)$/;
/**
 * A variable naming a file a non-interactive shell runs first: `BASH_ENV`, or `ENV` when its value is a path
 * (`ENV=production` is a common setting of its own).
 */
const STARTUP_FILE_VARIABLE = /^(?:BASH_ENV=|ENV=(?=\S*(?:\/|\.sh$)))/;
/**
 * The command words a {@link JOINED_RUNNERS} program hands a shell, or
 * undefined when it runs none: ssh's words after its host, watch's after its options (none under `-x`), and
 * tmux's after the options of a subcommand that starts a shell command.
 */
function joinedCommand(name, args) {
    let valued = JOINED_RUNNERS.get(name);
    if (valued === undefined) {
        return undefined;
    }
    let index = 0;
    if (name === 'tmux') {
        while (index < args.length && (args[index]?.text ?? '').startsWith('-')) {
            // `tmux -c command` runs command in a shell, as a login shell's -c does.
            if (args[index]?.text === '-c') {
                const command = args[index + 1];
                return command === undefined ? undefined : [command];
            }
            index += TMUX_GLOBAL_VALUED.has(args[index]?.text ?? '') ? 2 : 1;
        }
        valued = TMUX_SHELL_COMMANDS.get(args[index]?.text ?? '');
        if (valued === undefined) {
            return undefined;
        }
        index += 1;
    }
    for (; index < args.length; index += 1) {
        const text = args[index]?.text ?? '';
        if (text === '--') {
            index += 1;
            break;
        }
        if (!text.startsWith('-') || text === '-') {
            break;
        }
        if (name === 'watch' && (text === '-x' || text === '--exec')) {
            return undefined;
        }
        if (valued.has(text)) {
            index += 1;
        }
        else if (!text.startsWith('--')) {
            // A short cluster takes the next word when its last valued letter ends it (`-p22` holds its value).
            const at = [...text.slice(1)].findIndex((letter) => valued.has(`-${letter}`));
            if (at !== -1 && at === text.length - 2) {
                index += 1;
            }
        }
    }
    // ssh's first operand is its host.
    const rest = args.slice(name === 'ssh' ? index + 1 : index);
    return rest.length === 0 ? undefined : rest;
}
/** Bash builtins, which `hash -p` leaves running as themselves. */
const BASH_BUILTINS = new Set([
    ...['echo', 'printf', 'cd', 'pwd', 'true', 'false', 'test', '[', 'read', 'export', 'set', 'unset', 'shift', 'exit'],
    ...['return', 'source', '.', 'eval', 'exec', 'command', 'builtin', 'type', 'alias', 'unalias', 'hash', 'kill', 'wait'],
    ...['jobs', 'fg', 'bg', 'declare', 'typeset', 'local', 'readonly', 'let', 'shopt', 'trap', 'umask', 'ulimit', 'times'],
    ...['enable', 'help', 'history', 'mapfile', 'readarray', 'pushd', 'popd', 'dirs', 'disown', 'suspend', 'caller', ':'],
]);
/** Programs that run commands they read on stdin. */
const STDIN_RUNNERS = new Set(['ssh', 'at', 'batch', 'crontab', 'parallel', 'make', 'docker', 'podman', 'kubectl', 'su', 'machinectl', 'expect']);
/** Paths a process reads its own stdin through. */
const STDIN_PATH = /^\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;
/** Variables whose value a shell runs as commands later: before a prompt, at its start, or in a prompt. */
const CODE_VARIABLES = /^(?:PROMPT_COMMAND|BASH_ENV|ENV|PS[0124])(?:\[[^\]]*\])?\+?=/;
/** A shell's startup file, which every later shell runs. */
const STARTUP_FILE = /(?:^|\/)(?:\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|kshrc|mkshrc)|profile|bash\.bashrc|environment)$/;
/** The file a word names, in `dir` when relative; undefined when it is only known when it runs. */
function filePath(word, dir) {
    if (word.dynamic || word.text === '' || word.text.includes('\n')) {
        return undefined;
    }
    return isAbsolute(word.text) ? word.text : dir === undefined ? undefined : join(dir, word.text);
}
const MAX_ALIAS_DEPTH = 8;
const DIALECT_NAMES = { bash: 'bash', powershell: 'PowerShell', cmd: 'cmd' };
/** Variables that move git to another repository; set in the shell earlier in the line, they move every later git command. */
const GIT_DIR_VARIABLES = /^GIT_(?:DIR|COMMON_DIR)$/i;
/** Variables that change the config git reads. */
const GIT_CONFIG_VARIABLES = /^GIT_CONFIG/i;
/** The config key that moves git's hooks folder; `-c`, `GIT_CONFIG*` and `git config` keys are matched lowercased. */
export const HOOKS_PATH_KEY = 'core.hookspath';
/**
 * The variables that may turn git's hooks off: husky's switches, which its hooks read (`HUSKY=0` from husky 5 on,
 * `HUSKY_SKIP_HOOKS` before), and those that may set `core.hooksPath`.
 */
const HOOKS_VARIABLES = /^(?:HUSKY|HUSKY_SKIP_HOOKS|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+)$/i;
/** Bash builtins that set variables for the rest of the shell, such as `export GIT_DIR=x`. */
const BASH_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
/** PowerShell commands that set an `env:` item. */
const PS_ENV_SETTERS = /^(?:set-item|si|new-item|ni)$/i;
/** A word that stands for a value only known when the line runs, such as a `GIT_DIR` set earlier in the shell. */
const UNKNOWN_WORD = { text: '', dynamic: true };
/** The name `pattern` captures from a word, if any. */
const capturedName = (pattern) => (word) => {
    const name = pattern.exec(word.text)?.[1];
    return name === undefined ? [] : [name];
};
/**
 * The variables a command sets for the rest of its shell: bash `export X=1` or a bare `X=1`,
 * PowerShell `$env:X = 1` or `Set-Item env:X 1`, cmd `set X=1`. Variables a launcher sets for one
 * program (`X=1 git push`) are not here; see `launch`.
 */
export function shellVariables(words, dialect) {
    const [head, ...rest] = words;
    if (head === undefined) {
        return [];
    }
    const assigned = capturedName(/^([A-Za-z_]\w*)=/);
    switch (dialect) {
        case 'bash':
            if (BASH_SETTERS.has(head.text)) {
                return rest.flatMap(assigned);
            }
            return words.every((word) => isAssignment(word.text)) ? words.flatMap(assigned) : [];
        case 'powershell': {
            if (PS_ENV_SETTERS.test(head.text)) {
                return rest.flatMap(capturedName(/^env:\\?([A-Za-z_]\w*)$/i));
            }
            const target = /^\$env:([A-Za-z_]\w*)(\s*[-+*/]?=)?/i.exec(head.text);
            const assigns = target?.[2] !== undefined || /^[-+*/]?=/.test(rest[0]?.text ?? '');
            return target?.[1] !== undefined && assigns ? [target[1]] : [];
        }
        case 'cmd':
            return head.text.toLowerCase() === 'set' ? rest.flatMap(assigned) : [];
    }
}
/**
 * A launcher's variable as written when it may turn git's hooks off: `HUSKY=0`, a non-empty `HUSKY_SKIP_HOOKS`, a
 * `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_KEY_<n>` that names `core.hooksPath`, or one of them only known when it runs.
 */
function hooksVariable({ name, value }) {
    if (!HOOKS_VARIABLES.test(name)) {
        return undefined;
    }
    let off;
    if (value.dynamic) {
        off = true;
    }
    else if (GIT_CONFIG_VARIABLES.test(name)) {
        off = value.text.toLowerCase().includes(HOOKS_PATH_KEY);
    }
    else {
        off = name.toUpperCase() === 'HUSKY' ? value.text === '0' : value.text !== '';
    }
    return off ? `${name}=${value.text}` : undefined;
}
/** The first of `env` that may turn git's hooks off; see {@link hooksVariable}. */
function hooksVariableOf(env) {
    return env.map(hooksVariable).find((setting) => setting !== undefined);
}
/**
 * What `git config <args>` writes, in either form (`git config [--unset] key [value]` or `git config set|unset key
 * [value]`); undefined for a read, an edit, a section change or a line with no key.
 */
export function configWrite(args) {
    const operands = [];
    let unset = false;
    for (let index = 0; index < args.length; index += 1) {
        const word = args[index] ?? staticWord('');
        const [name, attached] = splitOption(word.text);
        if (CONFIG_READS.has(name)) {
            return undefined;
        }
        if (CONFIG_UNSETS.has(name)) {
            unset = true;
        }
        else if (word.text.startsWith('-')) {
            index += CONFIG_VALUED.has(name) && attached === undefined ? 1 : 0;
        }
        else {
            operands.push(word);
        }
    }
    const [first, ...rest] = operands;
    if (first?.text === 'unset') {
        const [key] = rest;
        return key === undefined ? undefined : { kind: 'unset', key };
    }
    if (first !== undefined && CONFIG_SUBCOMMANDS.has(first.text)) {
        return undefined;
    }
    const [key, value] = first?.text === 'set' ? rest : operands;
    if (key === undefined) {
        return undefined;
    }
    if (unset) {
        return { kind: 'unset', key };
    }
    return value === undefined ? undefined : { kind: 'set', key, value };
}
/** A command's terminator that pipes its output to the next command, a newline or two after it. */
const PIPE_TERMINATOR = /^\|&?\n*$/;
/** The compound commands' opening and closing reserved words, read where a command starts. */
const COMPOUND_OPENERS = new Set(['{', 'if', 'for', 'while', 'until', 'case', 'select']);
const COMPOUND_CLOSERS = new Set(['}', 'fi', 'done', 'esac']);
/** A redirection of stdout (`>`, `>>`, `>|`, `1>`, `&>`, `>&3`): its file descriptor, and a duplicated one. */
const STDOUT_REDIRECTION = /^(\d*|&)>(?:>|\|)?(?:&(\d+|-)?)?$/;
/** Where stdout going changes nothing: nowhere, or back to the terminal's own streams. */
const QUIET_OUTPUT = /^(?:\/dev\/(?:null|stdout|stderr|tty)|[12-])$/;
/**
 * True when what the command at `index` prints goes on, where a
 * shell may read it: into the command holding the substitution it sits in, down a pipe (`|`, `|&`), to a file or a
 * file descriptor other than the terminal's (`> x.sh`, `> >(sh)`, `>&3`), or out of a compound command it sits in
 * (`{ }`, `if`, `for`, `while`, `until`, `case`, a `( )` group) whose output goes on the same way.
 */
function outputGoesOn(commands, index) {
    const command = commands[index];
    if (command === undefined || command.nesting > 0 || sendsOutput(command)) {
        return command !== undefined;
    }
    let depth = 0;
    for (const later of commands.slice(index + 1)) {
        if (later.nesting !== command.nesting) {
            continue;
        }
        const inGroup = later.subshells.length > 0 && later.subshells.every((id, at) => command.subshells[at] === id);
        if (inGroup && later.terminator.includes(')') && sendsOutput(later)) {
            return true;
        }
        if (!sameSubshells(later, command)) {
            continue;
        }
        const words = later.words.map((word) => word.text);
        const opened = words.findIndex((word) => !COMPOUND_OPENERS.has(word));
        depth += opened === -1 ? words.length : opened;
        if (COMPOUND_CLOSERS.has(words[0] ?? '')) {
            depth -= 1;
            if (depth < 0) {
                // It closes a compound the command sits in.
                if (sendsOutput(later)) {
                    return true;
                }
                depth = 0;
            }
        }
    }
    return false;
}
/** True when a command's own output goes on: down a pipe, or to a file or file descriptor (see {@link outputGoesOn}). */
function sendsOutput(command) {
    if (PIPE_TERMINATOR.test(command.terminator.replace(/[()]/g, ''))) {
        return true;
    }
    return command.redirections.some((redirection) => {
        const match = STDOUT_REDIRECTION.exec(redirection.operator);
        if (match === null || !['', '1', '&'].includes(match[1] ?? '')) {
            return false;
        }
        const target = match[2] ?? redirection.target?.text ?? '';
        return !QUIET_OUTPUT.test(target);
    });
}
/** True when two commands run in the same chain of subshells. */
function sameSubshells(a, b) {
    return a.subshells.length === b.subshells.length && a.subshells.every((id, at) => b.subshells[at] === id);
}
/** Quotes a word for a bash command line, so a git shell alias gets its arguments as typed. */
function shellQuote(word) {
    return word.dynamic ? word.text : `'${word.text.replace(/'/g, `'\\''`)}'`;
}
/** What ends a piece of text for {@link saysPush}: blanks, quotes, operators and path separators, but not `-` or `.`. */
const MENTION_BREAKS = /[\s'"`;&|()<>{}[\]$=!:,/\\@%^#?*+~]+/;
/** A piece of text that names git's push: `push`, `--push`, `git-push` or `git-push.exe`. */
const PUSH_WORD = /^-*(?:git-)?push(?:\.exe)?$/i;
/** True when `text` names a push as a word of its own: `git push` or `X=push` do, `push-guard/` or `x-push.log` do not. */
function saysPush(text) {
    return text.split(MENTION_BREAKS).some((piece) => PUSH_WORD.test(piece));
}
/** Why `parsed` may not hold every command its line runs; undefined when it does. */
function unreadReason(parsed) {
    if (parsed.complete) {
        return undefined;
    }
    return parsed.readings?.every((reading) => reading.complete) === true
        ? "its words differ by the shell's version, its host or how it is started"
        : 'part of it cannot be read, as a quote, bracket or substitution never closes';
}
/** Splits `--option=value` into its name and attached value. */
function splitOption(text) {
    const equals = text.startsWith('--') ? text.indexOf('=') : -1;
    return equals === -1 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)];
}
/**
 * Finds every git command a command line runs. It reads the line as its shell would (see `parseShell`),
 * follows `cd` and friends, sees through launchers (see `launch`) into nested scripts, reads git's global
 * options, and expands git aliases (from `-c`, from a `git config alias.x` earlier in the line, or from git
 * config), including `!` shell aliases. Commands git itself runs (`submodule foreach`, `rebase --exec`,
 * `bisect run`, `filter-branch` filters) are read too. Whatever it cannot read becomes a {@link Doubt}.
 */
class GitInvocationFinder {
    invocations = [];
    doubts = [];
    mentionsPush = false;
    /** Aliases a `git config alias.x value` earlier in the line sets; undefined marks one only known when it runs. */
    lineAliases = new Map();
    /** True once the line sets a `GIT_DIR`-like variable in its shell, so later git commands run in a repository the guard cannot place. */
    shellMovesRepo = false;
    /** True once the line sets a `GIT_CONFIG*` variable in its shell. */
    shellOverridesConfig = false;
    /**
     * What turns git's hooks off for every git run of the shell being read: a hooks variable (see `HOOKS_VARIABLES`)
     * set in it earlier in the line, or one its launcher or parent git set, which a child shell inherits.
     */
    shellHooksOverride;
    /**
     * The doubts held text raises (see {@link visitHeld}), kept until the whole line is read: they
     * count only when something on the line can read that text again (see {@link rereads}).
     */
    heldDoubts = [];
    /** True once the line has something that reads text again as code; see {@link noteRereader}. */
    rereads = false;
    /** True once the line writes a file, and once it runs a program by its path. */
    writesFile = false;
    runsPath = false;
    /**
     * The files the line writes, by path, with the text it writes there,
     * or undefined when that text is not known (`echo ... > f`, `>>`, `tee`).
     */
    writtenFiles = new Map();
    /** True while the command being visited reads a pipe from the one before it. */
    fedByPipe = false;
    /**
     * The program names the line gives another meaning (see {@link noteRenames}): the words a name runs instead,
     * or undefined when that is not known.
     */
    renamed = new Map();
    context;
    constructor(context) {
        this.context = context;
    }
    find(command) {
        this.visitScript(staticWord(command), this.context.dialect, new Location(this.context.cwd, this.context.home), 0);
        // A file the line writes and then runs by its path may run text written into it as commands (one whose
        // text the guard cannot know is a doubt of its own; see visitScriptFile).
        if (this.rereads || (this.writesFile && this.runsPath)) {
            this.doubts.push(...this.heldDoubts);
        }
        return { invocations: this.invocations, doubts: this.doubts, mentionsPush: this.mentionsPush };
    }
    doubt(reason, gated) {
        this.doubts.push({ reason, gated });
    }
    mention(text) {
        this.mentionsPush ||= saysPush(text);
    }
    /**
     * Visits each command of a script in order. A heredoc or here-string is its command's stdin, and a plain
     * `cat` hands its stdin down a pipe to the next command, so `cat <<EOF | bash` runs the body as commands.
     */
    visitScript(script, dialect, location, depth) {
        const parsed = parseShell(script.text, dialect);
        this.visitParsed(parsed, script.text, unreadReason(parsed), dialect, location, depth);
    }
    /**
     * Visits the commands parsed from `source` in order; see {@link visitScript}. `unread` is the doubt when the
     * parse may not hold every command `source` runs.
     */
    visitParsed(parsed, source, unread, dialect, location, depth) {
        if (depth > MAX_SCRIPT_DEPTH) {
            this.doubt('scripts nest too deep to read', false);
            return;
        }
        if (unread !== undefined) {
            this.doubt(unread, true);
            this.mention(source);
        }
        parsed.unreadBodies.forEach((body) => this.mention(body.text));
        // bash reads $NAME set to a literal earlier in the line; other dialects keep every variable unknown. The
        // line's own shell has the user's HOME; a script it starts may be handed another (`HOME=x bash -c`).
        const commands = dialect === 'bash' ? resolveLiteralVariables(parsed, depth === 0 ? location.home : undefined) : parsed.commands;
        let piped;
        for (const command of commands) {
            let stdin = command.stdin ?? this.fileStdin(command, location);
            // A substitution's commands, read before the command that holds them, sit between a pipe's two ends.
            if (piped !== undefined && command.nesting <= piped.nesting) {
                stdin ??= command.nesting === piped.nesting && !redirectsInput(command) ? piped.body : undefined;
                piped = undefined;
            }
            location.enter(command.subshells);
            const before = commands[commands.indexOf(command) - 1];
            this.fedByPipe = before !== undefined && before.nesting === command.nesting && PIPE_TERMINATOR.test(before.terminator);
            this.noteCodeAssignments(command.words, dialect);
            this.visitStartupFiles(command.words, dialect, location, depth);
            const launched = this.visitCommand(dialect === 'bash' ? this.unrenamed(command.words) : command.words, dialect, location, depth, stdin);
            if (dialect === 'bash') {
                this.noteRenames(command.words);
            }
            // An interpreter's words and stdin are its script, judged by visitCommand, not shell words that name a push:
            // a python heredoc that posts a message saying "push" arms no doubt about the line. Its output going on (a pipe,
            // a substitution, a file) may be shell code it prints, so there its words and stdin still name a push for the
            // gated doubts what reads it raises (`python3 -c 'print("git push ...")' | sh`).
            const script = launched?.kind === 'program' && interpreterOf(launched) !== undefined && !outputGoesOn(commands, commands.indexOf(command));
            if (!script) {
                command.words.forEach((word) => this.mention(word.text));
            }
            // A shell that runs a word as a script reads its substitutions as commands already.
            if (launched?.kind !== 'script') {
                this.visitHeld(command.words, location, depth);
            }
            this.noteRereader(command, launched, source);
            if (stdin !== undefined) {
                const use = launched === undefined ? 'read' : stdinUse(command, launched);
                if (use !== 'stored' && !script) {
                    this.mention(stdin.text);
                }
                piped = use === 'passed' ? { body: stdin, nesting: command.nesting } : undefined;
            }
            this.noteWrites(command, launched, stdin, location);
        }
    }
    /**
     * Records the program names a command gives another meaning for the commands after it: `hash -p PATH NAME...`
     * runs PATH for each NAME (a builtin keeps its own meaning), `enable -f FILE NAME...` loads each NAME as a builtin
     * the guard cannot read, and `alias NAME=VALUE` runs VALUE's words. A PATH or VALUE only known when it runs is not
     * known either.
     */
    noteRenames(words) {
        const start = words.findIndex((word) => !isAssignment(word.text));
        const program = words[start];
        if (program === undefined || program.dynamic) {
            return;
        }
        const args = words.slice(start + 1);
        switch (program.text) {
            case 'hash': {
                const at = args.findIndex((arg) => arg.text === '-p');
                const path = args[at + 1];
                if (at === -1 || path === undefined) {
                    return;
                }
                for (const name of args.slice(at + 2).filter((arg) => !arg.dynamic && !arg.text.startsWith('-') && !BASH_BUILTINS.has(arg.text))) {
                    this.renamed.set(name.text, path.dynamic ? undefined : [path]);
                }
                return;
            }
            case 'enable': {
                const at = args.findIndex((arg) => /^-[a-z]*f$/.test(arg.text));
                if (at !== -1) {
                    args.slice(at + 2).filter((arg) => !arg.dynamic && !arg.text.startsWith('-')).forEach((name) => this.renamed.set(name.text, undefined));
                }
                return;
            }
            case 'alias':
                for (const arg of args) {
                    const equals = arg.text.indexOf('=');
                    if (equals > 0) {
                        const value = arg.text.slice(equals + 1);
                        this.renamed.set(arg.text.slice(0, equals), arg.dynamic ? undefined : value.split(/\s+/).filter(Boolean).map((text) => staticWord(text)));
                    }
                }
                return;
            default:
        }
    }
    /**
     * `words` with a program name an earlier command renamed (see {@link noteRenames}) replaced by what it runs,
     * also after `command` or `exec`; a name whose meaning is not known is a doubt when the line names a push.
     */
    unrenamed(words) {
        if (this.renamed.size === 0) {
            return words;
        }
        let at = words.findIndex((word) => !isAssignment(word.text));
        while (words[at] !== undefined && words[at]?.dynamic !== true && ['command', 'exec'].includes(words[at]?.text ?? '')) {
            at += 1;
            while (words[at]?.text.startsWith('-') === true) {
                at += 1;
            }
        }
        const name = words[at];
        if (name === undefined || name.dynamic || !this.renamed.has(name.text)) {
            return words;
        }
        const replacement = this.renamed.get(name.text);
        if (replacement === undefined) {
            this.doubt(`it runs ${name.text}, a program name the line gives a meaning only known when it runs`, true);
            return words;
        }
        return [...words.slice(0, at), ...replacement, ...words.slice(at + 1)];
    }
    /**
     * Records the files `command` writes (see {@link writtenFiles}): a
     * plain `cat` stores its heredoc or here-string there as written; any other write leaves the text unknown.
     */
    noteWrites(command, launched, stdin, location) {
        const stored = stdin !== undefined && !stdin.dynamic && launched !== undefined && stdinUse(command, launched) === 'stored' ? stdin.text : undefined;
        const record = (word, text) => {
            const path = filePath(word, location.dir) ?? (word.dynamic ? undefined : word.text);
            if (path !== undefined && !DEVICE_PATH.test(path)) {
                this.writtenFiles.set(path, text);
                // Every later shell runs a startup file.
                const written = text ?? [...command.words, ...(stdin === undefined ? [] : [stdin])].map((each) => each.text).join(' ');
                if (STARTUP_FILE.test(path) && saysPush(written)) {
                    this.doubt('it writes a push into a shell startup file, which every later shell runs', false);
                }
            }
        };
        for (const redirection of command.redirections) {
            if (WRITES_FILE.test(redirection.operator) && redirection.target !== undefined) {
                // Only stdout carries what a plain `cat` stores; `>>` appends to text the guard does not know.
                record(redirection.target, /^(?:1|&)?>[|]?$/.test(redirection.operator) ? stored : undefined);
            }
        }
        if (launched?.kind === 'program' && !launched.program.dynamic && programName(launched.program.text) === 'tee') {
            launched.args.filter((arg) => !arg.text.startsWith('-')).forEach((arg) => record(arg, undefined));
        }
    }
    /**
     * The texts a file may hold when a command of the line runs it: what
     * the line writes there (undefined when unknown), and what the disk holds, as a write may not run
     * (`false && cat > f.sh ...`, an `if`); `written` says whether the line writes it at all.
     */
    fileTexts(path) {
        const written = this.writtenFiles.has(path);
        return { written, writtenText: written ? this.writtenFiles.get(path) : undefined, diskText: (this.context.readScript ?? readScriptFile)(path) };
    }
    /** Every text a file may hold, joined, for an interpreter's text rule. */
    readFile = (path) => {
        const { writtenText, diskText } = this.fileTexts(path);
        const texts = [writtenText, diskText].filter((text) => text !== undefined);
        return texts.length === 0 ? undefined : texts.join('\n');
    };
    /**
     * Reads the shell script file `file` names and visits its commands, in
     * a shell of its own or, for `source` / `.`, the same shell. `byPath` is a file run as a program (`./x.sh`): one the
     * guard cannot read is a doubt only when its name says it is a shell script, as a missing binary runs nothing.
     * A file with a `#!` line for another language is read by that language's rule (see interpreters.ts); a binary
     * a shell refuses (see {@link looksBinary}) is left alone.
     */
    visitScriptFile(file, chdirs, env, sameShell, byPath, location, depth, stdin) {
        const inner = location.child();
        chdirs.forEach((chdir) => inner.moveTo(chdir));
        // `. /dev/stdin <<< X` runs the here-string; a pipe, unknown commands.
        if (!file.dynamic && STDIN_PATH.test(file.text)) {
            if (stdin === undefined) {
                this.doubt('a shell reads its commands from stdin', true);
            }
            else {
                this.inheriting(hooksVariableOf(env), sameShell, () => this.visitScript(stdin, 'bash', inner, depth + 1));
                if (sameShell) {
                    location.adopt(inner);
                }
            }
            return;
        }
        const path = filePath(file, inner.dir);
        if (path === undefined) {
            this.doubt('it runs a shell script file only known when it runs', true);
            return;
        }
        const { written, writtenText, diskText } = this.fileTexts(path);
        if (written && writtenText === undefined) {
            this.doubt('it runs a script file the line writes, whose text the guard cannot read', true);
        }
        else if (!written && diskText === undefined && (!byPath || SHELL_SCRIPT_NAME.test(path))) {
            this.doubt('it runs a shell script file the guard cannot read', true);
        }
        // A write the line makes may not run, so the file on disk is read as well.
        for (const text of [writtenText, diskText]) {
            if (text !== undefined) {
                this.visitScriptText(text, env, sameShell, chdirs, location, depth);
            }
        }
    }
    /** Visits one text a script file holds; see {@link visitScriptFile}. */
    visitScriptText(read, env, sameShell, chdirs, location, depth) {
        const inner = location.child();
        chdirs.forEach((chdir) => inner.moveTo(chdir));
        // bash refuses a file it runs as binary only when a NUL byte comes in its first line within the first 80
        // bytes it samples; a later one it runs past. `source` and `.` refuse nothing.
        if (!sameShell && looksBinary(read)) {
            return;
        }
        // bash drops the NUL bytes it reads, so `git pu<NUL>sh` runs `git push`.
        const text = read.replaceAll('\0', '');
        const shebang = SHEBANG.exec(text);
        let program = shebang?.[1] === undefined ? undefined : programName(shebang[1]);
        if (program === 'env' && shebang?.[2] !== undefined) {
            program = programName(shebang[2]);
        }
        if (program !== undefined && !isShell(program)) {
            const language = interpreterLanguage(program);
            if (language !== undefined && scriptMayPush(text, language)) {
                this.doubt(interpreterDoubt(language), false);
            }
            else if (language === undefined && saysPush(text)) {
                this.doubt(`it runs a ${program} script file that names a push, which the guard cannot read`, false);
            }
            return;
        }
        this.inheriting(hooksVariableOf(env), sameShell, () => this.visitScript(staticWord(text), 'bash', inner, depth + 1));
        if (sameShell) {
            location.adopt(inner);
        }
    }
    /**
     * Reads the command substitutions words hold as text (see `ShellWord.held`), which bash runs only when an
     * expansion reads the text again; until then the text is literal, as in an issue body that names a push. One
     * that pushes, or text the guard leaves unread, is a doubt when the text may be read again: at once for an
     * assignment's value, which a later expansion, on this line or one the guard never sees, may read; for any
     * other word only when the line has a re-reader (see {@link noteRereader}) or writes a file and runs a program
     * by its path, decided once the whole line is read (see {@link find}). Text that only never closes, such as a
     * grep pattern's escaped backtick, still shows every substitution bash runs there (see {@link parseHeldText}).
     */
    visitHeld(words, location, depth) {
        for (const word of words) {
            if (word.held === undefined) {
                continue;
            }
            const parsed = parseHeldText(word.held);
            const unread = parsed.skipped ? 'it holds quoted text the guard cannot read for the commands bash runs if an expansion reads it again' : undefined;
            const held = new GitInvocationFinder(this.context);
            held.visitParsed(parsed, word.held, unread, 'bash', location.child(), depth + 1);
            const found = [...held.doubts, ...held.heldDoubts];
            if (held.invocations.some((invocation) => invocation.subcommand === 'push')) {
                found.push({ reason: 'it holds a quoted command substitution that pushes, which bash runs if an expansion reads it again', gated: true });
            }
            // Quoted or escaped text is literal to bash: a `gh issue create --body 'run \`git push\`'`
            // runs nothing. A value a variable stores may be read again later, so an assignment doubts at once; any
            // other word only when the line has a re-reader (see find).
            (ASSIGNMENT_WORD.test(word.text) ? this.doubts : this.heldDoubts).push(...found);
        }
    }
    /**
     * Notes what in `command` can read held text again as code, counting only the program it
     * runs, never an argument: a shell or `eval` running a script, a command the guard cannot read, a shell or a
     * re-reading builtin as the program (see {@link REREADERS}), `xargs`, `env -S`, `printf -v`, a re-reading
     * expansion (see {@link REREADING_EXPANSION}) or an arithmetic command; and whether it writes a file or runs a
     * program by its path.
     */
    noteRereader(command, launched, source) {
        const names = commandNames(command.words);
        const program = launched?.kind === 'program' ? programName(launched.program.text) : undefined;
        const args = launched?.kind === 'program' ? launched.args : [];
        this.rereads ||=
            launched?.kind === 'script' ||
                launched?.kind === 'opaque' ||
                names.some((name) => REREADERS.has(name) || isShell(name)) ||
                (program !== undefined && (REREADERS.has(program) || isShell(program))) ||
                (launched?.kind === 'program' && launched.stdinArgs) ||
                (names.includes('env') && command.words.some((word) => /^(?:-[^-]*S|--split-string)/.test(word.text))) ||
                (program === 'printf' && args.some((word) => word.text.startsWith('-v'))) ||
                command.words.some((word) => word.dynamic && REREADING_EXPANSION.test(word.text)) ||
                ARITHMETIC_COMMAND.test(source);
        this.writesFile ||=
            program === 'tee' ||
                command.redirections.some((redirection) => WRITES_FILE.test(redirection.operator) && !/^\/dev\/null$/.test(redirection.target?.text ?? '/dev/null'));
        this.runsPath ||= launched?.kind === 'program' && /[\\/]/.test(launched.program.text);
    }
    /** Visits one simple command, given what it reads on stdin from the line; returns what it starts, or undefined for a `cd`. */
    visitCommand(words, dialect, location, depth, stdin) {
        for (const name of shellVariables(words, dialect)) {
            this.shellMovesRepo ||= GIT_DIR_VARIABLES.test(name);
            this.shellOverridesConfig ||= GIT_CONFIG_VARIABLES.test(name);
            this.shellHooksOverride ??= HOOKS_VARIABLES.test(name) ? `${name} set in its shell` : undefined;
        }
        if (location.apply(words, dialect)) {
            return undefined;
        }
        const launched = launch(words, dialect, stdin);
        switch (launched.kind) {
            case 'nothing':
                if (launched.scriptFile !== undefined && dialect === 'bash') {
                    this.visitScriptFile(launched.scriptFile, launched.chdirs ?? [], launched.env ?? [], false, false, location, depth, stdin);
                }
                break;
            case 'opaque':
                this.doubt(launched.reason, launched.gated);
                break;
            case 'script': {
                const inner = location.child();
                launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
                if (launched.script.dynamic && launched.dialect !== dialect) {
                    this.doubt(`it hands ${DIALECT_NAMES[launched.dialect]} a command line built from ${DIALECT_NAMES[dialect]} variables`, true);
                }
                this.inheriting(hooksVariableOf(launched.env), launched.sameShell, () => this.visitScript(launched.script, launched.dialect, inner, depth + 1));
                if (launched.sameShell) {
                    location.adopt(inner);
                }
                break;
            }
            case 'program': {
                // `source` / `.` run a script file in this shell, and a text
                // file run by its path is a script its `#!` line names, or a shell's.
                const programText = launched.program.dynamic ? undefined : launched.program.text;
                if (dialect === 'bash' && (programText === 'source' || programText === '.')) {
                    const file = launched.args[0];
                    if (file !== undefined) {
                        this.visitScriptFile(file, launched.chdirs, launched.env, true, false, location, depth, stdin);
                    }
                    break;
                }
                if (dialect === 'bash' && programText !== undefined && programText.includes('/') && interpreterOf(launched) === undefined) {
                    this.visitScriptFile(launched.program, launched.chdirs, launched.env, false, true, location, depth);
                    // A runner named by its path (`/usr/bin/ssh`) runs the same.
                    this.visitRunner(programName(programText), launched.args, stdin, location, depth);
                    // Git, or one of git's own commands, run by its path may be git's
                    // binary, which the script reader leaves alone, or a script of that name (`./git-status`): read it as both.
                    if (!isGitProgram(programName(programText))) {
                        break;
                    }
                }
                const language = interpreterOf(launched);
                if (language !== undefined) {
                    const inner = location.child();
                    launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
                    const text = interpreterText(launched, stdin, inner.dir, this.readFile, language);
                    if (scriptMayPush(text, language)) {
                        this.doubt(interpreterDoubt(language), false);
                    }
                    break;
                }
                const name = programName(launched.program.text);
                this.visitRunner(name, launched.args, stdin, location, depth);
                const subcommand = name.startsWith('git-') ? name.slice(4) : undefined;
                if (name !== 'git' && (subcommand === undefined || !BUILTINS.has(subcommand))) {
                    break;
                }
                const inner = location.child();
                launched.chdirs.forEach((chdir) => inner.moveTo(chdir));
                const args = subcommand === undefined ? launched.args : [staticWord(subcommand), ...launched.args];
                const tail = launched.stdinArgs ? [...args, { text: '<stdin>', dynamic: true }] : args;
                this.visitGit(tail, this.gitState(inner.dir, launched.env), depth, 0);
            }
        }
        return launched;
    }
    /**
     * Doubts a program that runs a command the guard cannot read (see
     * {@link ARGUMENT_RUNNERS}, {@link STDIN_RUNNERS}) when that command names a push.
     */
    visitRunner(name, args, stdin, location, depth) {
        this.visitJoined(name, args, stdin, location, depth);
        const reason = `it hands ${name} a command that names a push, which ${name} runs where the guard cannot read it`;
        if (ARGUMENT_RUNNERS.has(name) && runnerArgs(name, args).some((arg) => saysPush(arg.text))) {
            this.doubt(reason, false);
        }
        else if (STDIN_RUNNERS.has(name) && stdin !== undefined && saysPush(stdin.text)) {
            this.doubt(reason, false);
        }
        else if (STDIN_RUNNERS.has(name) && stdin === undefined && this.fedByPipe) {
            this.doubt(`it pipes commands into ${name}, which runs them where the guard cannot read them`, true);
        }
    }
    /**
     * Reads the command line a {@link JOINED_RUNNERS} program hands a shell
     * as the line's own commands, so a push the shell rebuilds (`git p\\ush`) is found. ssh runs it on another host,
     * in a folder the guard does not know. One built from variables is a doubt when the line names a push.
     */
    visitJoined(name, args, stdin, location, depth) {
        if (name === 'ssh') {
            this.visitSshOptions(args, location, depth);
        }
        // Ssh with no command runs its stdin in the remote login shell.
        if (name === 'ssh' && stdin !== undefined && !stdin.dynamic && joinedCommand(name, args) === undefined) {
            const remote = location.child();
            remote.moveTo({ text: '$REMOTE_HOME', dynamic: true });
            this.visitScript(stdin, 'bash', remote, depth + 1);
        }
        if (name === 'screen') {
            this.visitScreen(args, location, depth);
            return;
        }
        const words = joinedCommand(name, args);
        if (words === undefined) {
            return;
        }
        if (words.some((word) => word.dynamic)) {
            this.doubt(`${name} runs a command line only known when it runs`, true);
            return;
        }
        const inner = location.child();
        if (name === 'ssh') {
            inner.moveTo({ text: '$REMOTE_HOME', dynamic: true });
        }
        this.visitScript(staticWord(words.map((word) => word.text).join(' ')), 'bash', inner, depth + 1);
    }
    /**
     * Reads the commands an ssh `-o` option runs in a shell
     * (`ProxyCommand`, `LocalCommand` here, `RemoteCommand` on the host); one built from variables is a doubt when
     * the line names a push.
     */
    visitSshOptions(args, location, depth) {
        args.forEach((arg, at) => {
            const value = arg.text === '-o' ? args[at + 1] : arg.text.startsWith('-o') ? { text: arg.text.slice(2), dynamic: arg.dynamic } : undefined;
            const command = value === undefined ? undefined : SSH_COMMAND_OPTION.exec(value.text)?.[1];
            if (value === undefined || command === undefined) {
                return;
            }
            if (value.dynamic) {
                this.doubt('ssh runs a command line only known when it runs', true);
                return;
            }
            const inner = location.child();
            if (/^RemoteCommand/i.test(value.text)) {
                inner.moveTo({ text: '$REMOTE_HOME', dynamic: true });
            }
            this.visitScript(staticWord(command), 'bash', inner, depth + 1);
        });
    }
    /**
     * Reads the program `screen` starts after its options as a command
     * of its own (`screen -dm sh -c '...'`). `-X`, `-x`, `-r`, `-R`, `-ls` and `-wipe` talk to a session and start
     * nothing; the text rule of {@link ARGUMENT_RUNNERS} still checks them.
     */
    visitScreen(args, location, depth) {
        let index = 0;
        for (; index < args.length; index += 1) {
            const text = args[index]?.text ?? '';
            if (SCREEN_SESSION_OPTIONS.has(text)) {
                return;
            }
            if (!text.startsWith('-')) {
                break;
            }
            if (SCREEN_VALUED.has(text)) {
                index += 1;
                continue;
            }
            const cluster = screenCluster(text);
            if (cluster === 'session') {
                return;
            }
            if (cluster === 'valued') {
                index += 1;
            }
        }
        const rest = args.slice(index);
        if (rest.length > 0) {
            this.visitCommand(rest, 'bash', location.child(), depth + 1);
        }
    }
    /**
     * The text a `<` redirection feeds a shell or a stdin runner (see
     * {@link FILE_STDIN_READERS}) from a file, read as the line writes it or from disk. A file the guard cannot
     * read is a doubt when the line names a push.
     */
    fileStdin(command, location) {
        const input = command.redirections.findLast((redirection) => /^0?<>?$/.test(redirection.operator));
        if (input?.target === undefined || !command.words.some((word) => !word.dynamic && FILE_STDIN_READERS.test(programName(word.text)))) {
            return undefined;
        }
        const path = filePath(input.target, location.dir);
        const { writtenText, diskText } = path === undefined ? { writtenText: undefined, diskText: undefined } : this.fileTexts(path);
        const texts = [writtenText, diskText].filter((text) => text !== undefined);
        if (texts.length === 0) {
            // A shell fed a file it cannot read doubts already that it reads its commands from stdin.
            if (command.words.some((word) => !word.dynamic && STDIN_RUNNERS.has(programName(word.text)))) {
                this.doubt('it feeds a program commands from a file the guard cannot read', true);
            }
            return undefined;
        }
        return staticWord(texts.join('\n'));
    }
    /**
     * Reads the file `BASH_ENV` or `ENV` names, which a later
     * non-interactive shell runs first, as a script; one the guard cannot read is a doubt when the line names a push.
     */
    visitStartupFiles(words, dialect, location, depth) {
        if (dialect !== 'bash') {
            return;
        }
        const program = words.findIndex((word) => !isAssignment(word.text));
        // `env`, `declare -x` and friends set it as `export` does.
        const exported = EXPORTING_PROGRAMS.has(words[program]?.text ?? '');
        for (const [index, word] of words.entries()) {
            // `bash --rcfile f -i` runs f first.
            const rc = RC_FILE_OPTION.exec(word.text);
            if (rc !== null && !word.dynamic) {
                const file = rc[1] === undefined ? words[index + 1] : { text: rc[1], dynamic: false };
                if (file !== undefined) {
                    this.visitScriptFile(file, [], [], false, false, location, depth);
                }
                continue;
            }
            if (!STARTUP_FILE_VARIABLE.test(word.text) || (index > program && program !== -1 && !exported)) {
                continue;
            }
            const value = word.text.slice(word.text.indexOf('=') + 1);
            if (value === '') {
                continue;
            }
            this.visitScriptFile({ text: value, dynamic: word.dynamic }, [], [], false, false, location, depth);
        }
    }
    /**
     * Doubts a variable set to code a shell runs later (`PROMPT_COMMAND`,
     * `BASH_ENV`, a prompt) or an alias, when the code names a push.
     */
    noteCodeAssignments(words, dialect) {
        if (dialect !== 'bash') {
            return;
        }
        const alias = words[0]?.text === 'alias';
        for (const word of words) {
            if ((CODE_VARIABLES.test(word.text) || (alias && /^[^=\s]+=/.test(word.text))) && saysPush(word.text.slice(word.text.indexOf('=') + 1))) {
                this.doubt(alias ? 'it defines an alias that names a push, which a later command may run' : 'it sets a variable a shell runs as commands later to text that names a push', false);
            }
        }
    }
    /**
     * Runs `visit`, a read of a script whose shell inherits `hooksOverride` (from its launcher's variables or the git
     * that runs it) on top of its parent's. A child shell's own settings end with it; one in the same shell stays.
     */
    inheriting(hooksOverride, sameShell, visit) {
        const parent = this.shellHooksOverride;
        this.shellHooksOverride ??= hooksOverride;
        visit();
        if (!sameShell) {
            this.shellHooksOverride = parent;
        }
    }
    /**
     * What a git run inherits from its shell and from the variables its launcher sets: `GIT_DIR` moves it,
     * `GIT_CONFIG*` overrides config, a hooks variable may turn its hooks off. One set in the shell earlier in the
     * line is treated as unknown: the guard resolves an earlier literal only where a word reads it (`$NAME`), never
     * in the environment git inherits.
     */
    gitState(dir, env) {
        let gitDir = this.shellMovesRepo ? UNKNOWN_WORD : undefined;
        let overridden = this.shellOverridesConfig;
        for (const { name, value } of env) {
            if (GIT_DIR_VARIABLES.test(name)) {
                gitDir = name.toUpperCase() === 'GIT_DIR' ? value : UNKNOWN_WORD;
            }
            overridden ||= GIT_CONFIG_VARIABLES.test(name);
        }
        const hooksOverride = hooksVariableOf(env) ?? this.shellHooksOverride;
        return { dir, gitDir, configOverride: overridden, aliases: new Map(), aliasesUnknown: overridden, hooksOverride };
    }
    /** The folder git runs in: its `-C` folder, moved to its git dir when it has one. */
    repoDir(state) {
        const { dir, gitDir } = state;
        if (gitDir === undefined) {
            return dir;
        }
        return gitDir.dynamic ? undefined : resolveDir(dir, gitDir.text, this.context.home);
    }
    /** Reads git's global options, then runs the subcommand: a builtin, or an alias to expand. */
    visitGit(words, start, depth, aliasDepth) {
        let { dir, gitDir, configOverride, aliasesUnknown, hooksOverride } = start;
        const aliases = new Map(start.aliases);
        let index = 0;
        for (; index < words.length; index += 1) {
            const word = words[index] ?? staticWord('');
            if (!word.text.startsWith('-')) {
                break;
            }
            const [name, attached] = splitOption(word.text);
            if (word.dynamic && /[$`%@(]/.test(name)) {
                break;
            }
            if (GIT_INFO_OPTIONS.has(name) && attached === undefined) {
                return;
            }
            if (!GIT_VALUED_OPTIONS.has(name)) {
                continue;
            }
            const value = attached === undefined ? words[(index += 1)] : { text: attached, dynamic: word.dynamic };
            if (value === undefined) {
                return;
            }
            if (name === '-C') {
                dir = value.dynamic ? undefined : value.text === '' ? dir : resolveDir(dir, value.text, this.context.home);
            }
            else if (name === '--git-dir') {
                gitDir = value;
            }
            else if (name === '-c' || name === '--config-env') {
                const setting = /^([A-Za-z][\w.-]*)(?:=(.*))?$/s.exec(value.text);
                const key = setting?.[1]?.toLowerCase();
                if (key === undefined || (value.dynamic && /[$`%]/.test(key))) {
                    configOverride = true;
                    aliasesUnknown = true;
                    hooksOverride ??= `${name} ${value.text}`;
                }
                else if (key.startsWith('alias.')) {
                    aliases.set(key.slice('alias.'.length), value.dynamic || name === '--config-env' ? undefined : (setting?.[2] ?? 'true'));
                }
                else {
                    configOverride ||= PUSH_CONFIG.test(key);
                    hooksOverride ??= key === HOOKS_PATH_KEY ? `${name} ${value.text}` : undefined;
                }
            }
        }
        const sub = words[index];
        if (sub === undefined) {
            return;
        }
        if (sub.dynamic) {
            this.doubt('the git command it runs is only known when it runs', true);
            return;
        }
        const state = { dir, gitDir, configOverride, aliases, aliasesUnknown, hooksOverride };
        const args = words.slice(index + 1);
        if (BUILTINS.has(sub.text)) {
            const hooks = hooksOverride === undefined ? {} : { hooksOverride };
            this.builtin({ dir: this.repoDir(state), subcommand: sub.text, args, configOverride, ...hooks }, depth);
        }
        else {
            this.alias(sub.text, args, state, depth, aliasDepth);
        }
    }
    builtin(invocation, depth) {
        this.invocations.push(invocation);
        this.inheriting(invocation.hooksOverride, false, () => this.runsCommands(invocation, depth));
    }
    /** Reads the commands a git builtin runs itself, and records a `git config` alias; they inherit its hooks override. */
    runsCommands(invocation, depth) {
        const { args, dir } = invocation;
        switch (invocation.subcommand) {
            case 'config':
                this.registerAlias(args);
                return;
            case 'submodule':
                this.submoduleForeach(args, depth);
                return;
            case 'rebase':
                this.rebaseExec(args, dir, depth);
                return;
            case 'bisect':
                if (args[0]?.text === 'run' && args.length > 1) {
                    this.visitCommand(args.slice(1), 'bash', new Location(dir, this.context.home), depth + 1);
                }
                return;
            case 'filter-branch':
                args.forEach((arg, index) => {
                    const filter = args[index + 1];
                    if (FILTER_OPTIONS.has(arg.text) && filter !== undefined) {
                        this.visitScript(filter, 'bash', new Location(undefined, this.context.home), depth + 1);
                    }
                });
        }
    }
    /** Expands an alias; a name that is no alias is not a git command the guard reads (git extensions such as `git-foo` are not). */
    alias(name, args, state, depth, aliasDepth) {
        const key = name.toLowerCase();
        const repoDir = this.repoDir(state);
        let value;
        if (state.aliases.has(key)) {
            value = state.aliases.get(key);
        }
        else if (this.lineAliases.has(key)) {
            value = this.lineAliases.get(key);
        }
        else if (state.aliasesUnknown) {
            this.doubt(`"git ${name}" may be an alias a config override sets`, true);
            return;
        }
        else {
            const read = this.context.git.config(repoDir ?? this.context.cwd, `alias.${key}`);
            if (read.kind === 'unreadable') {
                this.doubt(`git could not read whether "git ${name}" is an alias`, false);
                return;
            }
            if (read.kind === 'unset') {
                if (repoDir === undefined) {
                    this.doubt(`"git ${name}" may be an alias of a repository only known when it runs`, true);
                }
                return;
            }
            value = read.value;
        }
        if (value === undefined) {
            this.doubt(`"git ${name}" is an alias whose value is only known when it runs`, true);
            return;
        }
        if (aliasDepth >= MAX_ALIAS_DEPTH) {
            this.doubt('git aliases nest too deep to read', false);
            return;
        }
        this.mention(value);
        if (value.startsWith('!')) {
            const script = [value.slice(1), ...args.map(shellQuote)].join(' ');
            this.inheriting(state.hooksOverride, false, () => this.visitScript(staticWord(script), 'bash', new Location(repoDir, this.context.home), depth + 1));
            return;
        }
        const expanded = splitGitAlias(value);
        if (expanded.kind === 'refused') {
            this.doubt(expanded.reason, true);
            return;
        }
        this.visitGit([...expanded.words, ...args], state, depth, aliasDepth + 1);
    }
    /** Records `git config [set] alias.x value`, so a later `git x` in the same line expands. */
    registerAlias(args) {
        const write = configWrite(args);
        if (write?.kind === 'set' && !write.key.dynamic && /^alias\./i.test(write.key.text)) {
            this.lineAliases.set(write.key.text.slice('alias.'.length).toLowerCase(), write.value.dynamic ? undefined : write.value.text);
        }
    }
    /** `git submodule [options] foreach [--recursive] <command>`: one word is a shell command, more are a program and its arguments. */
    submoduleForeach(args, depth) {
        let index = args.findIndex((arg) => !arg.text.startsWith('-'));
        if (index === -1 || args[index]?.text !== 'foreach') {
            return;
        }
        index += 1;
        while (args[index]?.text.startsWith('-') === true) {
            index += 1;
        }
        const command = args.slice(index);
        const location = new Location(undefined, this.context.home);
        const [only] = command;
        if (command.length === 1 && only !== undefined) {
            this.visitScript(only, 'bash', location, depth + 1);
        }
        else if (command.length > 1) {
            this.visitCommand(command, 'bash', location, depth + 1);
        }
    }
    /** `git rebase -x <cmd>` / `--exec <cmd>` runs each command in the shell after each commit. */
    rebaseExec(args, dir, depth) {
        for (let index = 0; index < args.length; index += 1) {
            const word = args[index] ?? staticWord('');
            const [name, attached] = splitOption(word.text);
            let command;
            if (name === '--exec' || name === '-x') {
                command = attached === undefined ? args[(index += 1)] : { text: attached, dynamic: word.dynamic };
            }
            else if (/^-x./s.test(word.text)) {
                command = { text: word.text.slice(2), dynamic: word.dynamic };
            }
            if (command !== undefined) {
                this.visitScript(command, 'bash', new Location(dir, this.context.home), depth + 1);
            }
        }
    }
}
/** Every git command `command` runs, and what the guard could not read; see {@link GitInvocationFinder}. */
export function findGitInvocations(command, context) {
    return new GitInvocationFinder(context).find(command);
}
