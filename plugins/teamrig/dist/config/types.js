/** The config format this code reads and writes. Older files are migrated in memory on load. */
export const CONFIG_VERSION = 1;
export const COMMIT_GATES = ['off', 'warn', 'refuse'];
export function isCommitGate(value) {
    return COMMIT_GATES.some((gate) => gate === value);
}
