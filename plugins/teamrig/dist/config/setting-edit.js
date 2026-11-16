import { isRecord } from "../core/guards.js";
/**
 * A value typed on a command line, read by the type the schema gives its key: `12` for an integer, `true` for a
 * boolean, the text itself for a string, and for a list of scalars a JSON array (`["a","b"]`) or a comma list (`a,b`,
 * empty for none). Refused, naming the key, when it is not that type, not one of its choices or out of its bounds; the
 * loader still checks the whole config after (patterns, keys that depend on each other).
 */
export function settingValueOf(row, text) {
    if (row.type === 'array') {
        const items = listItemsOf(text);
        if (!items.ok) {
            return { ok: false, problem: `${row.path} takes a list: ${items.problem}` };
        }
        const values = [];
        for (const item of items.value) {
            // The row's choices and bounds are the list's own; the schema gives an item only its type.
            const value = scalarOf({ path: row.path, type: row.items ?? 'string' }, item);
            if (!value.ok) {
                return value;
            }
            values.push(value.value);
        }
        return { ok: true, value: values };
    }
    return scalarOf(row, text);
}
function listItemsOf(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('[')) {
        return { ok: true, value: trimmed === '' ? [] : trimmed.split(',').map((item) => item.trim()) };
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return { ok: false, problem: `${text} is not a JSON array` };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, problem: `${text} is not a JSON array` };
    }
    // Each item goes back to text, so a JSON list and a comma list are read by the same rules.
    return { ok: true, value: parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))) };
}
function scalarOf(row, text) {
    const typed = typedOf(row.type, text);
    if (typed === undefined) {
        return { ok: false, problem: `${row.path} takes ${articleOf(row.type)} ${row.type}, not ${JSON.stringify(text)}` };
    }
    if (row.enum !== undefined && !row.enum.includes(typed)) {
        return { ok: false, problem: `${row.path} takes one of ${row.enum.map((choice) => JSON.stringify(choice)).join(', ')}, not ${JSON.stringify(text)}` };
    }
    if (typeof typed === 'number' && ((row.min !== undefined && typed < row.min) || (row.max !== undefined && typed > row.max))) {
        return { ok: false, problem: `${row.path} takes ${boundsText(row.min, row.max)}, not ${text}` };
    }
    return { ok: true, value: typed };
}
function typedOf(type, text) {
    switch (type) {
        case 'string':
            return text;
        case 'boolean':
            return text === 'true' ? true : text === 'false' ? false : undefined;
        case 'integer':
            return /^-?\d+$/.test(text.trim()) ? Number(text) : undefined;
        case 'number': {
            const value = text.trim() === '' ? Number.NaN : Number(text);
            return Number.isFinite(value) ? value : undefined;
        }
        default:
            return undefined;
    }
}
function articleOf(type) {
    return /^[aeiou]/.test(type) ? 'an' : 'a';
}
function boundsText(min, max) {
    if (min !== undefined && max !== undefined) {
        return `${min} to ${max}`;
    }
    return min !== undefined ? `${min} or more` : `${max ?? ''} or less`;
}
/** The value at a dotted path of the file, if it holds one. */
export function settingAt(file, path) {
    let node = file;
    for (const key of path.split('.')) {
        if (!isRecord(node)) {
            return undefined;
        }
        node = node[key];
    }
    return node;
}
/**
 * The file with the dotted path set to `value`, or removed when `value` is undefined so the key reads its default;
 * an object left empty by a removal goes too. Every other key stays as written.
 */
export function withSetting(file, path, value) {
    const [key, ...rest] = path.split('.');
    if (key === undefined) {
        return file;
    }
    if (rest.length === 0) {
        return value === undefined ? withoutKey(file, key) : { ...file, [key]: value };
    }
    const below = file[key];
    const child = withSetting(isRecord(below) ? below : {}, rest.join('.'), value);
    return Object.keys(child).length === 0 && value === undefined ? withoutKey(file, key) : { ...file, [key]: child };
}
function withoutKey(record, key) {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}
