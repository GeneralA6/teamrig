import type { ShellWord } from '../push-guard/tokenizer.ts';
import { apiEndpointOf, endpointPath, ghCommandSlotOf } from './gh-writes.ts';

/**
 * The teamrig command that does what a raw `gh` write on one of the team's repositories meant to do (T4819), named
 * in the exec guard's refusal so a session takes it at once instead of retrying gh. teamrig's commands write with the
 * key saved for the team's repositories and check who may; a write no command does yet goes to the session's lead.
 */

const REPLY = '`teamrig issue reply <owner/name#n> --body-file <file>` comments on an issue or pull request';
const CLOSE = '`teamrig issue close <owner/name#n> [--comment <text>]` closes an issue or pull request';
const LABEL = '`teamrig issue label <owner/name#n> --add|--remove <label,...>` sets its labels';
const ASSIGN = '`teamrig issue assign <owner/name#n> --add|--remove <login,...>` sets its assignees';
const EDIT = `\`teamrig issue edit <owner/name#n> --body-file <file>\` replaces its body; ${LABEL}; ${ASSIGN}; ${CLOSE}`;
const OPEN_ISSUE = '`teamrig add ... --issue "<title>" --issue-body "<text>"` opens an issue with its task';
const MERGE = '`teamrig merge`, run in the branch\'s folder, lands a branch (a repository\'s own merge command, such as its pull request flow, runs in its place)';

/** What a session does when no teamrig command does the write. */
export const ASK_LEAD = 'no teamrig command does this write yet: ask your lead, who has it done with the team\'s saved key';

/** The teamrig command for each `gh <group> <command>` write; every other write asks the lead. */
export const GH_WRITE_ROUTES: ReadonlyMap<string, string> = new Map([
  ['issue comment', REPLY],
  ['pr comment', REPLY],
  ['issue close', CLOSE],
  ['pr close', CLOSE],
  ['issue edit', EDIT],
  ['pr edit', EDIT],
  ['issue create', OPEN_ISSUE],
  ['pr create', MERGE],
  ['pr merge', MERGE],
]);

/** The teamrig command for a `gh api` write, by the `repos/<owner>/<name>/...` path it reaches. */
const API_ROUTES: readonly (readonly [RegExp, string])[] = [
  [/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u, REPLY],
  [/^repos\/[^/]+\/[^/]+\/issues\/\d+\/labels(?:\/[^/]+)?$/u, LABEL],
  [/^repos\/[^/]+\/[^/]+\/issues\/\d+\/assignees$/u, ASSIGN],
  [/^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/\d+$/u, EDIT],
  [/^repos\/[^/]+\/[^/]+\/issues$/u, OPEN_ISSUE],
  [/^repos\/[^/]+\/[^/]+\/pulls(?:\/\d+\/merge)?$/u, MERGE],
];

/** The teamrig command to run in place of a raw gh write, from its words after `gh`; `ASK_LEAD` when none does it. */
export function ghRouteOf(words: readonly ShellWord[]): string {
  const [group] = words;
  if (group === undefined || group.dynamic) {
    return ASK_LEAD;
  }
  if (group.text === 'api') {
    const endpoint = apiEndpointOf(words.slice(1));
    const path = endpoint === undefined || endpoint.dynamic ? undefined : endpointPath(endpoint.text);
    return API_ROUTES.find(([pattern]) => path !== undefined && pattern.test(path))?.[1] ?? ASK_LEAD;
  }
  const slot = ghCommandSlotOf(words.slice(1));
  if (slot.kind !== 'command' || slot.command === undefined || slot.command.dynamic) {
    return ASK_LEAD;
  }
  return GH_WRITE_ROUTES.get(`${group.text} ${slot.command.text}`) ?? ASK_LEAD;
}
