import { isRecord } from "../core/guards.js";
/**
 * Reads typed fields out of untrusted JSON. A missing field takes its default; a field of the
 * wrong type or failing its check is recorded as an issue and also takes its default, so one
 * pass reports every problem at once.
 */
export class ConfigReader {
    issues = [];
    /** A nested object; a missing one reads as empty so its fields take their defaults. */
    section(parent, key, path) {
        const value = parent[key];
        if (value === undefined) {
            return {};
        }
        if (isRecord(value)) {
            return value;
        }
        this.problem(join(path, key), 'an object', value);
        return {};
    }
    string(parent, key, path, fallback, check) {
        return this.optionalString(parent, key, path, check) ?? fallback;
    }
    optionalString(parent, key, path, check) {
        const value = parent[key];
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== 'string' || value.trim() === '') {
            this.problem(join(path, key), 'a non-empty string', value);
            return undefined;
        }
        return this.checked(join(path, key), value, check);
    }
    /** A string the team must supply; there is no default. */
    requiredString(parent, key, path, check) {
        if (parent[key] === undefined) {
            this.issues.push({ path: join(path, key), message: 'is required' });
            return '';
        }
        return this.optionalString(parent, key, path, check) ?? '';
    }
    integer(parent, key, path, fallback, bounds = {}) {
        return this.numeric(parent, key, path, fallback, bounds, true);
    }
    number(parent, key, path, fallback, bounds = {}) {
        return this.numeric(parent, key, path, fallback, bounds, false);
    }
    boolean(parent, key, path, fallback) {
        const value = parent[key];
        if (value === undefined) {
            return fallback;
        }
        if (typeof value !== 'boolean') {
            this.problem(join(path, key), 'true or false', value);
            return fallback;
        }
        return value;
    }
    /**
     * A list whose items are read by `item`; an item that returns undefined is dropped (it recorded
     * its issue). A list longer than `maxItems` is an issue and takes the default.
     */
    list(parent, key, path, fallback, item, maxItems = Number.POSITIVE_INFINITY) {
        const value = parent[key];
        if (value === undefined) {
            return fallback;
        }
        if (!Array.isArray(value)) {
            this.problem(join(path, key), 'a list', value);
            return fallback;
        }
        if (value.length > maxItems) {
            this.problem(join(path, key), `a list of at most ${maxItems} items`, value);
            return fallback;
        }
        const items = [];
        value.forEach((entry, index) => {
            const read = item(entry, `${join(path, key)}[${index}]`);
            if (read !== undefined) {
                items.push(read);
            }
        });
        return items;
    }
    stringList(parent, key, path, fallback, check, maxItems) {
        return this.list(parent, key, path, fallback, (value, itemPath) => this.stringItem(value, itemPath, check), maxItems);
    }
    /** One string list item, for use inside `list` callbacks. */
    stringItem(value, itemPath, check) {
        if (typeof value !== 'string' || value.trim() === '') {
            this.problem(itemPath, 'a non-empty string', value);
            return undefined;
        }
        return this.checked(itemPath, value, check);
    }
    /** One object list item, for use inside `list` callbacks. */
    objectItem(value, itemPath) {
        if (!isRecord(value)) {
            this.problem(itemPath, 'an object', value);
            return undefined;
        }
        return value;
    }
    /** Records a rule that spans several fields, such as "the lead must be one of the sessions". */
    report(path, message) {
        this.issues.push({ path, message });
    }
    numeric(parent, key, path, fallback, bounds, integer) {
        const value = parent[key];
        if (value === undefined) {
            return fallback;
        }
        const expected = `${integer ? 'an integer' : 'a number'}${describeBounds(bounds)}`;
        if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
            this.problem(join(path, key), expected, value);
            return fallback;
        }
        if ((bounds.min !== undefined && value < bounds.min) || (bounds.max !== undefined && value > bounds.max)) {
            this.problem(join(path, key), expected, value);
            return fallback;
        }
        return value;
    }
    checked(path, value, check) {
        const problem = check?.(value);
        if (problem !== undefined) {
            this.issues.push({ path, message: `${problem} (got ${describe(value)})` });
            return undefined;
        }
        return value;
    }
    problem(path, expected, value) {
        this.issues.push({ path, message: `expected ${expected}, got ${describe(value)}` });
    }
}
function join(path, key) {
    return path === '' ? key : `${path}.${key}`;
}
function describeBounds(bounds) {
    if (bounds.min !== undefined && bounds.max !== undefined) {
        return ` from ${bounds.min} to ${bounds.max}`;
    }
    if (bounds.min !== undefined) {
        return ` of at least ${bounds.min}`;
    }
    return bounds.max === undefined ? '' : ` of at most ${bounds.max}`;
}
/** A short, safe rendering of a bad value for an error message. */
export function describe(value) {
    const text = value === undefined ? 'nothing' : JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
export function formatIssue(issue) {
    return `${issue.path}: ${issue.message}`;
}
/** One line of at most `maxLength` characters that also passes `check`; for text printed into the rules. */
export function shortLine(maxLength, check) {
    return (value) => {
        if (/[\r\n]/.test(value)) {
            return 'expected a single line';
        }
        return value.length > maxLength ? `expected at most ${maxLength} characters` : check?.(value);
    };
}
/** Validates a regular expression source; used for team-supplied patterns. */
export const isValidRegex = (source) => {
    try {
        new RegExp(source, 'u');
        return undefined;
    }
    catch (error) {
        return `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    }
};
