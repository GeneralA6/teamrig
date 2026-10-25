import { isRecord } from "../core/guards.js";
import { sendTargetOf, sendTextOf } from "./cold-send.js";
import { toolResponseOf } from "./post-tool-use.js";
/** The delivered send a PostToolUse payload reports; undefined for any other tool, a send that failed or a result it cannot read. */
export function deliveredSendOf(payload) {
    const to = sendTargetOf(payload);
    if (to === undefined || !isRecord(payload)) {
        return undefined;
    }
    const response = toolResponseOf(payload['tool_response']);
    return response?.['success'] === true ? { to, text: sendTextOf(payload) } : undefined;
}
