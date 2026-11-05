import { echoes, printsHeld } from "./env.js";
import { isPrinter } from "./files.js";
import { printsInline } from "./inline.js";
/** A redirection of stdout to a file: `>`, `>>`, `1>`, `>|`, and `&>` or `*>`, which take every stream. */
const STDOUT_TO_FILE = /^(?:1?>[>|]?|&>>?|\*>>?)$/;
/** A redirection of stdout back to the screen: `>&2`, `1>&2`. */
const STDOUT_TO_SCREEN = /^1?>&[12]$/;
/** A file that is the screen. */
const SCREEN = /^(?:\/dev\/(?:stdout|stderr|tty|fd\/[12])|con|-)$/i;
/** Programs that take what is piped into them on without printing it: into a file, the clipboard, an agent, a digest. */
const PASSERS = new Set([
    'set-content',
    'sc',
    'add-content',
    'ac',
    'out-file',
    'out-null',
    'clip',
    'pbcopy',
    'xclip',
    'xsel',
    'wl-copy',
    'set-clipboard',
    'scb',
    'ssh-add',
    'wc',
    'measure-object',
    'measure',
    'cksum',
    'md5sum',
    'sha1sum',
    'sha256sum',
    'sha512sum',
    'shasum',
    'b2sum',
]);
/** Options with which a program reads a secret on stdin to use it: `docker login --password-stdin`, `gh auth login --with-token`. */
const STDIN_OPTION = /stdin|^--with-token$|^--pass(?:word|phrase)-fd/i;
/** Subcommands that store what they read on stdin as a secret: `gh secret set`, `wrangler secret put`, `vercel env add`. */
const STORES_STDIN = /\bsecrets? (?:put|set|import)\b|\benv add\b/i;
/** For each search program, the short options that make it print no matched line: quiet, count, file names only. */
const SEARCH_QUIET_LETTERS = new Map([
    ['grep', 'qclL'],
    ['egrep', 'qclL'],
    ['fgrep', 'qclL'],
    ['zgrep', 'qclL'],
    ['rg', 'qcl'],
    ['ag', 'clL'],
    ['ack', 'clL'],
]);
const SEARCH_QUIET_OPTIONS = /^--(?:quiet|silent|count|count-matches|files-with-matches|files-without-match)$/;
/** Programs that edit their files in place with -i, printing nothing. */
const IN_PLACE_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby']);
/**
 * True when nothing the command prints reaches the conversation: its stdout goes to a file, a PowerShell assignment
 * takes it, a substitution hands it to a command that does not print it (`curl -H "$(cat t)"`), it pipes into a
 * program that passes it on unprinted (or prints nothing itself), or its options make it print no content at all, as
 * `grep -q` and `sed -i` do. A pipe or a substitution into a command only known when it runs counts as printed.
 */
export function quiet(command) {
    if (stdoutToFile(command.redirections) || ('captured' in command && command.captured) || ('name' in command && printsNoContent(command))) {
        return true;
    }
    if (command.substitution !== undefined && !holderPrints(command.substitution.holder)) {
        return true;
    }
    const into = command.pipe?.into;
    return into !== undefined && (passesOn(into) || quiet(into));
}
/**
 * True when the command holding a substitution prints the value it takes: an echo, a file printer, inline code that
 * prints (`node -e "console.log('$(cat t)')"`), a PowerShell expression other than a call taking it as an argument.
 */
function holderPrints(holder) {
    if (holder === undefined) {
        return true;
    }
    const prints = 'name' in holder ? echoes(holder) || isPrinter(holder.name) || printsInline(holder) : printsHeld(holder);
    return prints && !quiet(holder);
}
/** True when the last redirection of stdout sends it to a file. */
function stdoutToFile(redirections) {
    let toFile = false;
    for (const { operator, target } of redirections) {
        if (STDOUT_TO_FILE.test(operator) && target !== undefined) {
            toFile = !SCREEN.test(target.text);
        }
        else if (STDOUT_TO_SCREEN.test(operator)) {
            toFile = false;
        }
    }
    return toFile;
}
/** True when the program takes what is piped into it on as a value, never printing it. */
function passesOn(run) {
    const texts = run.args.map((arg) => arg.text);
    return PASSERS.has(run.name) || texts.some((text) => STDIN_OPTION.test(text)) || STORES_STDIN.test(texts.join(' '));
}
/** True when the program's options make it print no content: a quiet or counting search, an in-place edit. */
function printsNoContent(run) {
    const options = run.args.map((arg) => arg.text).filter((text) => text.startsWith('-'));
    const quietLetters = SEARCH_QUIET_LETTERS.get(run.name);
    if (quietLetters !== undefined) {
        return options.some((option) => SEARCH_QUIET_OPTIONS.test(option) || (/^-[^-]/.test(option) && [...option.slice(1)].some((letter) => quietLetters.includes(letter))));
    }
    if (run.name === 'select-string' || run.name === 'sls') {
        return options.some((option) => /^-quiet$/i.test(option));
    }
    if (IN_PLACE_EDITORS.has(run.name)) {
        return options.some((option) => option === '--in-place' || option.startsWith('--in-place=') || /^-[a-hj-zA-HJ-Z]*i/.test(option));
    }
    return false;
}
