/** The break-through file's text: one JSON object and a newline. */
export function formatBreakthrough(breakthrough) {
    return `${JSON.stringify(breakthrough)}\n`;
}
/** Records `breakthrough` as the last one, replacing any earlier. */
export async function recordBreakthrough(files, path, breakthrough) {
    await files.write(path, formatBreakthrough(breakthrough));
}
