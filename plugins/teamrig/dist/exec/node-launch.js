import { envVariable } from "../core/path-search.js";
/** The options that load no code, by their name with dashes, with the value each takes. */
const ALLOWED = new Map([
    ['--no-warnings', 'none'],
    ['--no-deprecation', 'none'],
    ['--enable-source-maps', 'none'],
    ['--disable-warning', 'word'],
    ['--max-old-space-size', 'count'],
]);
/** NODE_OPTIONS split into words as node splits it: on spaces, where double quotes hold spaces and a backslash in them takes the next character as it is. */
export function nodeOptionsWords(text) {
    const words = [];
    let word;
    let quoted = false;
    let escaping = false;
    for (const char of text) {
        if (escaping) {
            escaping = false;
        }
        else if (quoted && char === '\\') {
            escaping = true;
            continue;
        }
        else if (char === '"') {
            quoted = !quoted;
            continue;
        }
        else if (char === ' ' && !quoted) {
            if (word !== undefined) {
                words.push(word);
            }
            word = undefined;
            continue;
        }
        word = (word ?? '') + char;
    }
    if (word !== undefined) {
        words.push(word);
    }
    return words;
}
/** An option's name as node matches it: underscores after the leading `--` read as dashes (`--max_old_space_size`). */
function canonicalName(name) {
    return name.startsWith('--') ? `--${name.slice(2).replaceAll('_', '-')}` : name;
}
function fitsValue(kind, value) {
    return kind === 'count' ? /^\d+$/.test(value) : value !== '' && !value.startsWith('-');
}
/** How many words an option takes from `word` on (itself, or itself and its value), and whether it is outside the list. */
function stepOf(word, next) {
    const equals = word.indexOf('=');
    const name = canonicalName(equals === -1 ? word : word.slice(0, equals));
    const value = equals === -1 ? undefined : word.slice(equals + 1);
    const kind = ALLOWED.get(name);
    const spacedValue = value === undefined && next !== undefined && !next.startsWith('-') ? next : undefined;
    if (kind === undefined) {
        return { width: spacedValue === undefined ? 1 : 2, foreign: true };
    }
    if (kind === 'none') {
        return { width: 1, foreign: value !== undefined };
    }
    if (value !== undefined) {
        return { width: 1, foreign: !fitsValue(kind, value) };
    }
    return spacedValue === undefined ? { width: 1, foreign: true } : { width: 2, foreign: !fitsValue(kind, spacedValue) };
}
function foreignIn(words, source) {
    const foreign = [];
    let end = 0;
    words.forEach((word, index) => {
        if (index < end) {
            return;
        }
        const step = stepOf(word, words[index + 1]);
        end = index + step.width;
        if (step.foreign) {
            foreign.push({ option: words.slice(index, end).join(' '), source });
        }
    });
    return foreign;
}
/** The options outside the list that node runs with: those on its command line (`process.execArgv`), then NODE_OPTIONS's. */
export function foreignNodeOptions(execArgv, nodeOptions) {
    return [...foreignIn(execArgv, 'command line'), ...foreignIn(nodeOptions === undefined ? [] : nodeOptionsWords(nodeOptions), 'NODE_OPTIONS')];
}
/** Where an option sits, in words. */
function placeOf(source) {
    return source === 'NODE_OPTIONS' ? 'in NODE_OPTIONS' : "on node's command line";
}
/**
 * Why an exec command refuses to run on this node, or undefined when node runs with listed options only. NODE_OPTIONS
 * is read as node reads it: on Windows its name ignores case.
 */
export function nodeLaunchRefusal(execArgv, env, platform) {
    const foreign = foreignNodeOptions(execArgv, envVariable(env, 'NODE_OPTIONS', platform));
    if (foreign.length === 0) {
        return undefined;
    }
    const named = foreign.map(({ option, source }) => `${option} (${placeOf(source)})`).join(', ');
    const fixes = [
        ...(foreign.some(({ source }) => source === 'command line') ? ["drop them from node's command line"] : []),
        ...(foreign.some(({ source }) => source === 'NODE_OPTIONS') ? ['unset NODE_OPTIONS or take them out of it'] : []),
    ];
    return `teamrig exec runs only on a node with no option that can run code beside the client, and this one has ${named}; ${fixes.join(' and ')}, then run it again.`;
}
