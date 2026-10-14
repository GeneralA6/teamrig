import { ID_PATTERN, NAME_PATTERN } from "./ids.js";
/** A qualified session id, `<team>/<id>`, as a register records a task sourced from another team. */
export const ADDRESS_PATTERN = new RegExp(`^${ID_PATTERN.source.slice(1, -1)}/${ID_PATTERN.source.slice(1, -1)}$`);
/** `<team>/<session>` or a bare `<session>`; undefined for anything else. */
export function splitAddress(text) {
    const parts = text.split('/');
    const [first, second] = parts;
    if (parts.length === 1 && first !== undefined && NAME_PATTERN.test(first)) {
        return { team: undefined, session: first };
    }
    if (parts.length === 2 && first !== undefined && second !== undefined && ID_PATTERN.test(first) && NAME_PATTERN.test(second)) {
        return { team: first, session: second };
    }
    return undefined;
}
export function formatAddress(address) {
    return `${address.team}/${address.id}`;
}
