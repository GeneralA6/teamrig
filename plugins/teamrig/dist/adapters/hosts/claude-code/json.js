import { isRecord } from "../../../plugin-api/index.js";
/** A text as the JSON object it holds, spaces around it left out; undefined when it is not JSON or holds no object. */
export function objectOf(text) {
    try {
        const value = JSON.parse(text.trim());
        return isRecord(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
