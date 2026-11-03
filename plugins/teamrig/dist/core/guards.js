export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
export function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
export function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
/** The field as a finite number; undefined when it is absent, not a number, NaN or infinite. */
export function numberField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** The field as an instant (ms since the epoch) from the ISO text a file keeps; undefined when it is absent or no instant. */
export function instantField(record, key) {
    const text = stringField(record, key);
    const ms = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(ms) ? undefined : ms;
}
export function recordField(record, key) {
    const value = record[key];
    return isRecord(value) ? value : undefined;
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** The `code` of a Node system error (ENOENT, EEXIST, ...), if any. */
export function errorCode(error) {
    return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}
