import { isRecord, recordField, stringField, type CloseReason, type JsonRecord } from '../../../plugin-api/index.ts';
import { reasonOf } from './resolution.ts';

/**
 * How a Jira issue is closed: Jira has no close, only the transitions an issue's workflow offers from its status, so
 * closing is choosing one that ends in a closed status and, when its screen takes a resolution, the resolution to send
 * with it. What Jira answers is outside input: a transition that does not read as one is passed over.
 */

/** The status category Jira puts every closed status in, whatever a site names the status. */
const DONE_CATEGORY = 'done';

/** Whether `status` (an issue's, or the one a transition ends in) is a closed one. */
export function isDoneStatus(status: JsonRecord | undefined): boolean {
  return status !== undefined && stringField(recordField(status, 'statusCategory') ?? {}, 'key') === DONE_CATEGORY;
}

/** The transition that closes an issue: its id, and the id of the resolution to send with it, when one goes with it. */
export interface ClosingStep {
  readonly id: string;
  readonly resolution: string | undefined;
}

interface Resolution {
  readonly id: string;
  readonly name: string;
}

/** A transition that ends in a closed status: the status's name, and the resolutions its screen takes, when it takes one. */
interface Candidate {
  readonly id: string;
  readonly status: string;
  readonly resolutions: readonly Resolution[];
  readonly resolutionRequired: boolean;
}

function resolutionOf(value: unknown): Resolution | undefined {
  const id = isRecord(value) ? stringField(value, 'id') : undefined;
  const name = isRecord(value) ? stringField(value, 'name') : undefined;
  return id === undefined || id === '' || name === undefined ? undefined : { id, name };
}

function candidateOf(value: unknown): Candidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, 'id');
  const to = recordField(value, 'to');
  if (id === undefined || id === '' || to === undefined || !isDoneStatus(to)) {
    return undefined;
  }
  const field = recordField(recordField(value, 'fields') ?? {}, 'resolution');
  const allowed: unknown = field?.['allowedValues'];
  return {
    id,
    status: stringField(to, 'name') ?? '',
    resolutions: (Array.isArray(allowed) ? allowed : []).flatMap((item: unknown) => resolutionOf(item) ?? []),
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
export function closingStep(answer: unknown, reason: CloseReason): ClosingStep | undefined {
  const transitions: unknown = isRecord(answer) ? answer['transitions'] : undefined;
  const candidates = (Array.isArray(transitions) ? transitions : []).flatMap((value: unknown) => candidateOf(value) ?? []);
  const resolutionFor = (candidate: Candidate): Resolution | undefined => candidate.resolutions.find((resolution) => reasonOf(resolution.name) === reason);
  const pick =
    candidates.find((candidate) => reasonOf(candidate.status) === reason) ??
    candidates.find((candidate) => resolutionFor(candidate) !== undefined) ??
    candidates.find((candidate) => reasonOf(candidate.status) === undefined) ??
    candidates[0];
  if (pick === undefined) {
    return undefined;
  }
  const resolution = resolutionFor(pick) ?? (pick.resolutionRequired ? pick.resolutions[0] : undefined);
  return { id: pick.id, resolution: resolution?.id };
}
