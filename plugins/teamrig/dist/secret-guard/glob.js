/**
 * Globs as the secret guard reads them, compiled to regular expressions over a normalised path (forward slashes):
 * `**` spans folders (`**\/` also none), `*` and `?` stay inside one name, `[...]` is one character of a set.
 */
/** True when `text` holds a wildcard a shell or the guard expands: `*`, `?` or a `[...]` set. */
export function hasWildcard(text) {
    return /[*?]|\[[^\]/]+\]/.test(text);
}
/** `glob` as a regular expression that matches a whole path. */
export function globRegExp(glob, options) {
    let source = '';
    let index = 0;
    while (index < glob.length) {
        const nameStart = index === 0 || glob[index - 1] === '/';
        const noDot = !options.dotfiles && nameStart ? '(?!\\.)' : '';
        if (glob.startsWith('**/', index) && nameStart) {
            source += options.dotfiles ? '(?:.*/)?' : '(?:(?!\\.)[^/]*/)*';
            index += 3;
        }
        else if (glob.startsWith('**', index) && nameStart && index + 2 === glob.length) {
            source += options.dotfiles ? '.*' : '(?:(?!\\.)[^/]*(?:/|$))*';
            index += 2;
        }
        else if (glob.startsWith('/**', index) && index + 3 === glob.length) {
            source += options.dotfiles ? '(?:/.*)?' : '(?:/(?!\\.)[^/]*)*';
            index += 3;
        }
        else {
            const [part, next] = globPart(glob, index);
            source += (part.startsWith('[') || part.startsWith('(?:[^/]') ? noDot : '') + part;
            index = next;
        }
    }
    return new RegExp(`^${source}$`, options.ignoreCase ? 'i' : '');
}
/** The expression for one glob character, or a `[...]` set, at `index`, and the index after it. */
function globPart(glob, index) {
    const char = glob[index] ?? '';
    if (char === '*') {
        let end = index;
        while (glob[end] === '*') {
            end += 1;
        }
        return ['(?:[^/]*)', end];
    }
    if (char === '?') {
        return ['(?:[^/])', index + 1];
    }
    if (char === '[') {
        const close = glob.indexOf(']', index + 2);
        const body = close === -1 ? '' : glob.slice(index + 1, close);
        if (close !== -1 && !body.includes('/')) {
            const negated = body.startsWith('!') || body.startsWith('^');
            const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&');
            return [`[${negated ? '^/' : ''}${members}]`, close + 1];
        }
    }
    return [char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), index + 1];
}
