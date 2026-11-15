/**
 * Globs as the secret guard reads them, compiled to regular expressions over a normalised path (forward slashes):
 * `**` spans folders (`**\/` also none), `*` and `?` stay inside one name, `[...]` is one character of a set: a `!` or
 * `^` after the `[` negates it, its first member may be a `]`, a reversed range fits nothing, the members around it
 * still do, and a set left empty is literal text.
 */
const FOLDERS_CHAR = { kind: 'char', source: '.', role: 'folders' };
const FOLDERS_NAME_CHAR = { kind: 'char', source: '[^/]', role: 'folders' };
const FOLDERS_SLASH = { kind: 'char', source: '/', role: 'folders' };
const STAR_CHAR = { kind: 'char', source: '[^/]', role: 'star' };
const ONE_CHAR = { kind: 'char', source: '[^/]', role: 'one' };
const NOT_DOT = { kind: 'notDot' };
const repeat = (...body) => ({ kind: 'repeat', body });
const optional = (...body) => ({ kind: 'optional', body });
/** A name that never starts with a dot: what a bash `**` spans each folder of. */
const BARE_NAME = [NOT_DOT, repeat(FOLDERS_NAME_CHAR)];
/** A character a regular expression's set reads as syntax. */
const SET_SYNTAX = /[\\\]^-]/;
/**
 * The plain globs a glob with `{a,b}` alternatives stands for, as ripgrep reads them: `*.{ts,pem}` gives `*.ts` and
 * `*.pem`. A brace inside a `[...]` set, an escaped one or one that never closes is a plain character. A group inside
 * an alternative is spelled out too: ripgrep 15 reads it so, and 14 refuses the glob, so the reading costs nothing
 * there. Undefined past `limit` globs, so the caller can count such a glob as naming anything.
 */
export function braceAlternatives(glob, limit) {
    const spelled = [];
    let pending = [glob];
    while (pending.length > 0) {
        const next = [];
        for (const item of pending) {
            const group = firstGroup(item);
            // Counted before the spread: past about 120,000 arguments a spread throws instead of reaching the limit.
            if (spelled.length + next.length + (group?.choices.length ?? 1) > limit) {
                return undefined;
            }
            if (group === undefined) {
                spelled.push(plainGlob(item));
            }
            else {
                next.push(...group.choices.map((choice) => `${item.slice(0, group.open)}${choice}${item.slice(group.close + 1)}`));
            }
        }
        pending = next;
    }
    return spelled;
}
/**
 * `glob` without what ripgrep reads away: the `\` of an escaped character, on Windows too, and a `}` no `{` opened, so
 * `*.\pem` and `*.pem}` both pick `b.pem`. An escaped `*` comes out a wildcard, which reads wider: the safe side.
 */
function plainGlob(glob) {
    let plain = '';
    for (let index = 0, end = 0; index < glob.length; index = end) {
        end = tokenEnd(glob, index);
        const token = glob.slice(index, end);
        if (token !== '}') {
            plain += token.startsWith('\\') ? token.slice(1) : token;
        }
    }
    return plain;
}
/** The first `{...}` group of `glob` that closes, outside any `[...]` set. */
function firstGroup(glob) {
    for (let open = nextBrace(glob, 0); open !== -1; open = nextBrace(glob, open + 1)) {
        const group = groupAt(glob, open);
        if (group !== undefined) {
            return group;
        }
    }
    return undefined;
}
/** The index of the first `{` at or after `from` that is neither escaped nor in a `[...]` set, or -1. */
function nextBrace(glob, from) {
    for (let index = from; index < glob.length; index = tokenEnd(glob, index)) {
        if (glob[index] === '{') {
            return index;
        }
    }
    return -1;
}
/** The group that opens at `open`, its inner groups left in its choices; undefined when it never closes. */
function groupAt(glob, open) {
    const choices = [];
    let depth = 0;
    let start = open + 1;
    for (let index = open + 1; index < glob.length; index = tokenEnd(glob, index)) {
        const char = glob[index];
        if (char === '}' && depth === 0) {
            choices.push(glob.slice(start, index));
            return { open, close: index, choices };
        }
        if (char === '{') {
            depth += 1;
        }
        else if (char === '}') {
            depth -= 1;
        }
        else if (char === ',' && depth === 0) {
            choices.push(glob.slice(start, index));
            start = index + 1;
        }
    }
    return undefined;
}
/** The index after what starts at `index`: an escaped character, a `[...]` set, or one character. */
function tokenEnd(glob, index) {
    return glob[index] === '\\' ? index + 2 : (setEnd(glob, index) ?? index + 1);
}
/**
 * The index after a `[...]` set that starts at `index`, read as ripgrep reads one: a `!` or `^` after the `[` negates,
 * the first member may be a `]`, and a `/` is a member like any other, so `{[{/],*.pem}` holds the set `[{/]` and the
 * choice `*.pem`. Undefined for no set, or one that never closes: ripgrep refuses that glob, and reading its `[` as a
 * plain character spells out more choices, the safe side.
 */
function setEnd(glob, index) {
    if (glob[index] !== '[') {
        return undefined;
    }
    const first = glob[index + 1] === '!' || glob[index + 1] === '^' ? index + 2 : index + 1;
    const close = glob.indexOf(']', first + 1);
    return close === -1 ? undefined : close + 1;
}
/**
 * True when `text` holds a wildcard a shell or the guard expands: `*`, `?` or a `[...]` set. One set no character fits
 * (`[z-a]`) means none: the word can match no file, so bash keeps all of it as typed, and it names that literal path.
 */
export function hasWildcard(text, sets) {
    let wildcard = false;
    for (let index = 0; index < text.length;) {
        const set = setAt(text, index, sets);
        if (set?.expression === undefined && set !== undefined) {
            return false;
        }
        wildcard ||= set !== undefined || text[index] === '*' || text[index] === '?';
        index = set?.end ?? index + 1;
    }
    return wildcard;
}
/** `glob` as a regular expression that matches a whole path. */
export function globRegExp(glob, options) {
    return new RegExp(`^${nodesSource(globNodes(glob, options))}$`, options.ignoreCase ? 'i' : '');
}
/** The pieces of `glob`, read as `options` say. */
export function globNodes(glob, options) {
    const nodes = [];
    let index = 0;
    while (index < glob.length) {
        const nameStart = index === 0 || glob[index - 1] === '/';
        if (glob.startsWith('**/', index) && nameStart) {
            nodes.push(options.dotfiles ? optional(repeat(FOLDERS_CHAR), FOLDERS_SLASH) : repeat(...BARE_NAME, FOLDERS_SLASH));
            index += 3;
        }
        else if (glob.startsWith('**', index) && nameStart && index + 2 === glob.length) {
            nodes.push(...(options.dotfiles ? [repeat(FOLDERS_CHAR)] : [repeat(...BARE_NAME, FOLDERS_SLASH), ...BARE_NAME]));
            index += 2;
        }
        else if (glob.startsWith('/**', index) && index + 3 === glob.length) {
            nodes.push(options.dotfiles ? optional(FOLDERS_SLASH, repeat(FOLDERS_CHAR)) : repeat(FOLDERS_SLASH, ...BARE_NAME));
            index += 3;
        }
        else {
            const part = globPart(glob, index, options.sets);
            if (part.wildcard && nameStart && !options.dotfiles) {
                nodes.push(NOT_DOT);
            }
            nodes.push(part.node);
            index = part.end;
        }
    }
    return nodes;
}
/** `nodes` as the source of a regular expression. */
function nodesSource(nodes) {
    return nodes
        .map((node) => {
        switch (node.kind) {
            case 'char':
                return node.source;
            case 'notDot':
                return '(?!\\.)';
            case 'repeat':
                return `(?:${nodesSource(node.body)})*`;
            case 'optional':
                return `(?:${nodesSource(node.body)})?`;
        }
    })
        .join('');
}
/** One glob character, a run of `*`, or a `[...]` set, at `index`: its piece, whether it is a wildcard, and the index after it. */
function globPart(glob, index, sets) {
    const char = glob[index] ?? '';
    if (char === '*') {
        let end = index;
        while (glob[end] === '*') {
            end += 1;
        }
        return { node: repeat(STAR_CHAR), wildcard: true, end };
    }
    if (char === '?') {
        return { node: ONE_CHAR, wildcard: true, end: index + 1 };
    }
    const set = setAt(glob, index, sets);
    if (set?.expression !== undefined) {
        return { node: { kind: 'char', source: set.expression, role: 'one' }, wildcard: true, end: set.end };
    }
    return { node: { kind: 'char', source: char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), role: 'literal' }, wildcard: false, end: index + 1 };
}
/**
 * The `[...]` set at `index`, as `sets` reads it: its expression (undefined when no character fits it) and the index
 * after it. Undefined where the `[` is a plain character: no set closes there, or, read as bash, the set holds a `/`.
 */
function setAt(glob, index, sets) {
    const end = setEnd(glob, index);
    const body = end === undefined ? '' : glob.slice(index + 1, end - 1);
    return end === undefined || (sets === 'bash' && body.includes('/')) ? undefined : { expression: setExpression(body, sets), end };
}
/** The expression for the `[...]` set with inside `body`, or undefined when no character fits it. */
function setExpression(body, sets) {
    const negated = body.startsWith('!') || body.startsWith('^');
    const members = setMembers(negated ? body.slice(1) : body);
    if (negated) {
        return sets === 'bash' ? `[^/${members}]` : `[^${members}]`;
    }
    return members === '' ? undefined : `[${members}]`;
}
/**
 * The members of a set, for a regular expression's set. A reversed range (`z-a`) stays out: `new RegExp` throws on one,
 * and reading the whole set as literal text instead would let `.en[z-av]` reach `.env` unseen, as bash still fits the
 * `v`. A `-` left over is escaped, so that a dropped range cannot join the members on either side of it into a new one.
 */
function setMembers(body) {
    const member = (char) => char.replace(SET_SYNTAX, '\\$&');
    let members = '';
    let index = 0;
    while (index < body.length) {
        const first = body.charAt(index);
        const last = body.charAt(index + 2);
        if (body.charAt(index + 1) === '-' && last !== '') {
            members += first <= last ? `${member(first)}-${member(last)}` : '';
            index += 3;
        }
        else {
            members += member(first);
            index += 1;
        }
    }
    return members;
}
