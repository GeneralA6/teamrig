/**
 * The literal specifiers a JavaScript or TypeScript module loads (T3419): read from its code, never from a comment, a
 * string or a regular expression, so text that only names an import (a doc comment's `from './x'`) loads nothing.
 *
 * A small scanner, not a full parse: it steps over comments, strings, template literals (with their `${…}` code) and
 * regular expressions, and reads a string that follows `from`, `import`, `import(` or `new URL(`. A template literal
 * with no `${…}` in those places counts as a string; one with `${…}` is built at run time and names no file.
 */
/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** The token a string, template or regular expression leaves: a value, after which a `/` divides. */
const VALUE = '"';
const WORD = /[\w$]/;
/**
 * The specifiers `text` loads, in order: `import … from 'x'`, `export … from 'x'`, `import 'x'`, `import('x')` and
 * `new URL('x', …)`. Undefined when a comment, string, template or regular expression does not end, as the code
 * cannot then be told apart from text.
 */
export function moduleSpecifiersOf(text) {
    const found = [];
    const recent = [];
    const push = (token) => {
        recent.push(token);
        if (recent.length > 3)
            recent.shift();
    };
    const wantsSpecifier = () => {
        const [a, b, c] = [recent.at(-3), recent.at(-2), recent.at(-1)];
        return c === 'from' || c === 'import' || (b === 'import' && c === '(') || (a === 'new' && b === 'URL' && c === '(');
    };
    const startsExpression = () => {
        const last = recent.at(-1);
        if (last === undefined || BEFORE_EXPRESSION.has(last))
            return true;
        return !WORD.test(last) && last !== ')' && last !== ']' && last !== '}' && last !== VALUE;
    };
    /** Brace depth at each open `${`, innermost last; `depth` counts the code's own open braces. */
    const interpolations = [];
    const templates = [];
    let depth = 0;
    let inTemplate = false;
    let i = text.startsWith('#!') ? lineEnd(text, 0) : 0;
    while (i < text.length) {
        if (inTemplate) {
            const template = templates.at(-1);
            const char = text[i];
            if (template === undefined)
                return undefined;
            if (char === '\\') {
                i += 2;
            }
            else if (char === '`') {
                templates.pop();
                if (template.wanted && template.plain)
                    found.push(text.slice(template.from, i));
                push(VALUE);
                inTemplate = false;
                i += 1;
            }
            else if (char === '$' && text[i + 1] === '{') {
                template.plain = false;
                interpolations.push(depth);
                inTemplate = false;
                i += 2;
            }
            else {
                i += 1;
            }
            continue;
        }
        const char = text[i] ?? '';
        const next = text[i + 1];
        if (/\s/.test(char)) {
            i += 1;
        }
        else if (char === '/' && next === '/') {
            i = lineEnd(text, i);
        }
        else if (char === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end === -1)
                return undefined;
            i = end + 2;
        }
        else if (char === "'" || char === '"') {
            const end = stringEnd(text, i);
            if (end === undefined)
                return undefined;
            if (wantsSpecifier())
                found.push(text.slice(i + 1, end));
            push(VALUE);
            i = end + 1;
        }
        else if (char === '`') {
            templates.push({ from: i + 1, wanted: wantsSpecifier(), plain: true });
            inTemplate = true;
            i += 1;
        }
        else if (char === '/' && startsExpression()) {
            const end = regexEnd(text, i);
            if (end === undefined)
                return undefined;
            push(VALUE);
            i = end;
        }
        else if (WORD.test(char)) {
            let end = i + 1;
            while (end < text.length && WORD.test(text[end] ?? ''))
                end += 1;
            push(text.slice(i, end));
            i = end;
        }
        else if (char === '}' && interpolations.at(-1) === depth) {
            interpolations.pop();
            inTemplate = true;
            i += 1;
        }
        else {
            if (char === '{')
                depth += 1;
            if (char === '}')
                depth -= 1;
            push(char);
            i += 1;
        }
    }
    return inTemplate || templates.length > 0 ? undefined : found;
}
/** The index of the line end at or after `from`, or the text's end. */
function lineEnd(text, from) {
    const end = text.indexOf('\n', from);
    return end === -1 ? text.length : end;
}
/** The index of the quote that closes the string opening at `from`; undefined when a line or the text ends first. */
function stringEnd(text, from) {
    const quote = text[from];
    for (let i = from + 1; i < text.length; i += 1) {
        const char = text[i];
        if (char === '\\')
            i += 1;
        else if (char === quote)
            return i;
        else if (char === '\n')
            return undefined;
    }
    return undefined;
}
/** The index past the flags of the regular expression opening at `from`; undefined when a line or the text ends first. */
function regexEnd(text, from) {
    let inClass = false;
    for (let i = from + 1; i < text.length; i += 1) {
        const char = text[i];
        if (char === '\\') {
            i += 1;
        }
        else if (char === '\n') {
            return undefined;
        }
        else if (char === '[') {
            inClass = true;
        }
        else if (char === ']') {
            inClass = false;
        }
        else if (char === '/' && !inClass) {
            let end = i + 1;
            while (end < text.length && /[a-z]/i.test(text[end] ?? ''))
                end += 1;
            return end;
        }
    }
    return undefined;
}
