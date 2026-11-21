import { sentMessageOf } from "./cold-send.js";
import { toolResponseOf } from "./post-tool-use.js";
/** The delivered send the event of a finished call reports; undefined for a call of any other kind, a send that failed or a result it cannot read. */
export function deliveredSendOf(event) {
    const sent = sentMessageOf(event);
    if (sent === undefined) {
        return undefined;
    }
    return toolResponseOf(event.call?.response)?.['success'] === true ? { to: sent.to, text: sent.text } : undefined;
}
