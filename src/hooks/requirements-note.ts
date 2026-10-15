import { describeRequirement, type RequirementProblem } from '../requirements/requirements.ts';
import { firstHint, type HintLog } from './hint-log.ts';

/** The hint log's reason for the requirements note. */
export const REQUIREMENTS_HINT = 'requirements';

export interface RequirementsNoteInput {
  readonly problems: readonly RequirementProblem[];
  readonly log: HintLog;
  /** The Claude Code session, from the hook payload; null when the payload has none. */
  readonly claudeSession: string | null;
  readonly now: Date;
  /** The CLI name the lines name. */
  readonly command: string;
}

/**
 * The session start's note to the user of what teamrig lacks, one line per problem, given once per Claude
 * Code session: the hook also fires on resume, clear and compact. The log is read only when something is
 * missing; a payload with no session id gets the note every time.
 */
export async function requirementsNoteOnce(input: RequirementsNoteInput): Promise<string | undefined> {
  if (input.problems.length === 0) {
    return undefined;
  }
  if (input.claudeSession !== null && !(await firstHint(input.log, input.claudeSession, REQUIREMENTS_HINT, input.now))) {
    return undefined;
  }
  return input.problems.map((problem) => describeRequirement(problem, input.command)).join('\n');
}
