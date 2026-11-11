/**
 * The value of `key` in the text of a secrets file holding many keys: the first line `<key>: <value>` or
 * `<key>=<value>`, indented or not, so one parse reads a YAML map (such as a Kubernetes secret's `stringData` block)
 * and a `.env` file alike. A value in double or single quotes is what the quotes hold; a bare one ends at a ` #`
 * comment. Undefined when no line sets the key, or its quote is never closed. The text is a secret: nothing here
 * logs it or throws with it.
 */
export function secretValueOf(text, key) {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimStart();
        const named = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
        if (!named.startsWith(key)) {
            continue;
        }
        const rest = named.slice(key.length).trimStart();
        if (rest.startsWith(':') || rest.startsWith('=')) {
            return valueOf(rest.slice(1).trim());
        }
    }
    return undefined;
}
function valueOf(text) {
    const quote = text[0];
    if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, 1);
        return end < 0 ? undefined : text.slice(1, end);
    }
    const comment = text.search(/\s#/);
    return (comment < 0 ? text : text.slice(0, comment)).trim();
}
