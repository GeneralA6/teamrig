import { isRecord, stringField } from "../core/guards.js";
import { isReservedName, RESERVED_RULE } from "../core/ids.js";
import { sendTargetOf } from "./cold-send.js";
import { toolResponseOf } from "./post-tool-use.js";
/** The failed send a PostToolUse payload reports; undefined for any other tool or a delivered message. */
export function failedSendOf(payload) {
    const to = sendTargetOf(payload);
    if (to === undefined || !isRecord(payload)) {
        return undefined;
    }
    const response = toolResponseOf(payload['tool_response']);
    if (response === undefined || response['success'] !== false) {
        return undefined;
    }
    const reason = stringField(response, 'message')?.split('\n')[0]?.trim();
    return { to, reason: reason === undefined || reason === '' ? 'not delivered' : reason };
}
/**
 * The line for the model: where the message goes now. `id` is the team session `failed.to` names; for a
 * name that is no team session the line points to `who`, which prints the names to message by. For a name Claude
 * Code reserves (T1124) it also says why, so the sender stops messaging it.
 */
export function failedSendLine(failed, id, command) {
    const next = id === undefined
        ? `${failed.to} is no team session name (\`${command} who\` prints them); for a team session, leave it as an inbox line: \`${command} inbox add --to <area> --text "..."\`.`
        : `leave it as an inbox line, shown at ${id}'s next prompt: \`${command} inbox add --to ${id} --text "..."\`.`;
    const never = isReservedName(failed.to) ? ` ${failed.to} ${RESERVED_RULE}.` : '';
    return `${command}: the message to ${failed.to} was not sent (${failed.reason}); ${next}${never}`;
}
