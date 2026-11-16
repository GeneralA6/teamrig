import { DESIGN_LABEL } from './design-label.ts';
import { targetText, type IssueHost, type IssueTarget } from './host.ts';

/** The most logins one assign adds and takes off together: a hand write gives an item to its takers, never a crowd. */
export const MAX_ASSIGN_LOGINS = 3;

/** The longest login a host keeps; GitHub's are at most 39 characters. */
const MAX_LOGIN = 100;

/** Who to add to an item's assignees and who to take off it; each login once. */
export interface AssignWrite {
  readonly target: IssueTarget;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

/** How an assign ended: every step done, a step failed, or it was refused before anything was sent for a reason a retry cannot change. */
export type AssignEnd = 'done' | 'failed' | 'refused';

/** Why `login` is no login a host takes, or undefined when it may be one: empty, holding a space or a control character, or too long. */
export function loginRefusal(login: string): string | undefined {
  if (login === '') {
    return 'a login is empty';
  }
  if (/[\p{Cc}\s]/u.test(login)) {
    return `the login ${JSON.stringify(login)} holds a space or a control character`;
  }
  return login.length > MAX_LOGIN ? `the login ${JSON.stringify(login)} is ${login.length} characters, over the ${MAX_LOGIN} a login may hold` : undefined;
}

/**
 * Adds and takes off assignees through `host`, one line said for each step: ACCESS, then ASSIGNED and UNASSIGNED, or
 * FAILED or REFUSED with the reason. Before any write: an add to a design issue is refused, as design talk is no work
 * to take until it is agreed and its label comes off; and each login to add is read as one the host may assign to
 * this very item (someone with access to the repository, or someone who took part in the item, such as a commenter
 * asking to take it), so the host never drops one silently. The first failure stops it, and a failure after a write
 * says what was done.
 */
export async function assignIssue(host: IssueHost, write: AssignWrite, say: (line: string) => void): Promise<AssignEnd> {
  const shown = targetText(write.target);
  const reach = await host.reach(write.target.repo, 'write');
  if (reach.kind === 'unreachable') {
    say(`FAILED ${shown}: ${reach.reason}; nothing was changed`);
    return 'failed';
  }
  say(`ACCESS ${reach.access}`);
  const spelled: string[] = [];
  if (write.add.length > 0) {
    const labels = await host.issueLabels(write.target);
    if (labels.kind !== 'read') {
      say(`FAILED ${shown}: ${labels.kind === 'failed' ? labels.reason : `${host.name} shows no such issue or pull request`}; nothing was changed`);
      return 'failed';
    }
    if (labels.labels.includes(DESIGN_LABEL)) {
      say(`REFUSED ${shown}: it is a design issue, talk and not work to take, so no one is assigned until it is agreed and the ${JSON.stringify(DESIGN_LABEL)} label comes off; nothing was changed`);
      return 'refused';
    }
    for (const login of write.add) {
      const found = await host.assignableOn(write.target, login);
      if (found.kind === 'missing') {
        say(`REFUSED ${shown}: ${login} may not be assigned to it: ${host.name} assigns only someone with access to the repository, or someone who took part in the item; nothing was changed`);
        return 'refused';
      }
      if (found.kind === 'failed') {
        say(`FAILED ${shown}: ${found.reason}; nothing was changed`);
        return 'failed';
      }
      spelled.push(found.login);
    }
  }
  const done: string[] = [];
  const failed = (reason: string): 'failed' => {
    say(`FAILED ${shown}: ${reason}${done.length === 0 ? '; nothing was changed' : `; it already ${done.join(', ')}`}`);
    return 'failed';
  };
  if (spelled.length > 0) {
    const assigned = await host.assign(write.target, spelled);
    if (assigned.kind === 'failed') {
      return failed(assigned.reason);
    }
    say(`ASSIGNED ${shown}: ${spelled.join(', ')}`);
    done.push(`assigned ${spelled.join(', ')}`);
  }
  for (const login of write.remove) {
    const removed = await host.unassign(write.target, login);
    if (removed.kind === 'failed') {
      return failed(removed.reason);
    }
    say(`UNASSIGNED ${shown}: ${login}`);
    done.push(`took off ${login}`);
  }
  return 'done';
}
