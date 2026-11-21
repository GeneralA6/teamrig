import { isRecord, recordField, stringField } from "../../../plugin-api/index.js";
import { reasonOf } from "./resolution.js";
/**
 * How a Jira issue is closed: Jira has no close, only the transitions an issue's workflow offers from its status, so
 * closing is choosing one that ends in a closed status and, when its screen takes a resolution, the resolution to send
 * with it. What Jira answers is outside input: a transition that does not read as one is passed over.
 */
/** The status category Jira puts every closed status in, whatever a site names the status. */
const DONE_CATEGORY = 'done';
/** Whether `status` (an issue's, or the one a transition ends in) is a closed one. */
export function isDoneStatus(status) {
    return status !== undefined && stringField(recordField(status, 'statusCategory') ?? {}, 'key') === DONE_CATEGORY;
}
function resolutionOf(value) {
    const id = isRecord(value) ? stringField(value, 'id') : undefined;
    const name = isRecord(value) ? stringField(value, 'name') : undefined;
    return id === undefined || id === '' || name === undefined ? undefined : { id, name };
}
function candidateOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const id = stringField(value, 'id');
    const to = recordField(value, 'to');
    if (id === undefined || id === '' || to === undefined || !isDoneStatus(to)) {
        return undefined;
    }
    const field = recordField(recordField(value, 'fields') ?? {}, 'resolution');
    const allowed = field?.['allowedValues'];
    return {
        id,
        status: stringField(to, 'name') ?? '',
        resolutions: (Array.isArray(allowed) ? allowed : []).flatMap((item) => resolutionOf(item) ?? []),
        resolutionRequired: field?.['required'] === true,
    };
}
/**
 * The transition to close an issue by for `reason`, out of Jira's answer to the transitions it offers (asked with
 * their fields), or undefined when none ends in a closed status. Taken in this order: one whose closed status is named
 * for the reason; one whose screen takes a resolution named for it; one whose status is named for no reason; the
 * first. So an issue always closes when its workflow lets it, and keeps the reason when the workflow has a name for
 * it. The resolution sent is the one named for the reason, else the first allowed when the screen must have one.
 */
export function closingStep(answer, reason) {
    const transitions = isRecord(answer) ? answer['transitions'] : undefined;
    const candidates = (Array.isArray(transitions) ? transitions : []).flatMap((value) => candidateOf(value) ?? []);
    const resolutionFor = (candidate) => candidate.resolutions.find((resolution) => reasonOf(resolution.name) === reason);
    const pick = candidates.find((candidate) => reasonOf(candidate.status) === reason) ??
        candidates.find((candidate) => resolutionFor(candidate) !== undefined) ??
        candidates.find((candidate) => reasonOf(candidate.status) === undefined) ??
        candidates[0];
    if (pick === undefined) {
        return undefined;
    }
    const resolution = resolutionFor(pick) ?? (pick.resolutionRequired ? pick.resolutions[0] : undefined);
    return { id: pick.id, resolution: resolution?.id };
}
