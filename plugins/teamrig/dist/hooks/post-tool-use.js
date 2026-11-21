import { isRecord } from "../core/guards.js";
/** The tool's result as a record: Claude Code may hand it over as the object or as its JSON text. */
export function toolResponseOf(value) {
    if (typeof value !== 'string') {
        return isRecord(value) ? value : undefined;
    }
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
