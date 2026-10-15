import { describeRequirement } from "../requirements/requirements.js";
import { firstHint } from "./hint-log.js";
/** The hint log's reason for the requirements note. */
export const REQUIREMENTS_HINT = 'requirements';
/**
 * The session start's note to the user of what teamrig lacks, one line per problem, given once per Claude
 * Code session: the hook also fires on resume, clear and compact. The log is read only when something is
 * missing; a payload with no session id gets the note every time.
 */
export async function requirementsNoteOnce(input) {
    if (input.problems.length === 0) {
        return undefined;
    }
    if (input.claudeSession !== null && !(await firstHint(input.log, input.claudeSession, REQUIREMENTS_HINT, input.now))) {
        return undefined;
    }
    return input.problems.map((problem) => describeRequirement(problem, input.command)).join('\n');
}
