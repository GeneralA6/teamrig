import { KIT_NAME } from '../core/home.ts';
import { privateShapeIn } from '../core/private-shapes.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { targetText, type CloseReason, type IssueHost, type IssueTarget } from './host.ts';
import { taskIdIn } from './posted.ts';

/** The longest comment GitHub takes; another host's limit is checked by the host itself. */
export const MAX_COMMENT = 65_536;

/** The longest label name GitHub takes. */
export const MAX_LABEL = 50;

/** What to write on one issue or pull request: a comment, a close (with its reason when given), or a comment and then a close. */
export interface IssueWrite {
  readonly target: IssueTarget;
  readonly comment?: string;
  readonly close: boolean;
  readonly reason?: CloseReason;
}

/** The labels to add to one issue or pull request and those to take off it. */
export interface LabelWrite {
  readonly target: IssueTarget;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

/** Why `label` is no label name a host takes, or undefined when it is one: holding a control character, empty, padded or too long. */
export function labelRefusal(label: string): string | undefined {
  if (/\p{Cc}/u.test(label)) {
    return `the label ${JSON.stringify(label)} holds a control character`;
  }
  if (label.trim() === '') {
    return 'a label name is empty';
  }
  if (label.trim() !== label) {
    return `the label ${JSON.stringify(label)} starts or ends with a space`;
  }
  return label.length > MAX_LABEL ? `the label ${JSON.stringify(label)} is ${label.length} characters, over the ${MAX_LABEL} a label may hold` : undefined;
}

/** The labels as a line shows them: each quoted, as a label is outside text and may hold a comma or a space. */
function labelsText(labels: readonly string[]): string {
  return labels.map((label) => JSON.stringify(label)).join(', ');
}

/**
 * Adds and takes off labels through `host`, one line said for each step: ACCESS, then LABELED and UNLABELED, or
 * FAILED with the reason. Every label to add must already be one of the repository's, read before any write, so a
 * typo never makes a new label; the first failure stops it, and a failure after a write says what was done. True
 * when every step was done.
 */
export async function labelIssue(host: IssueHost, write: LabelWrite, say: (line: string) => void): Promise<boolean> {
  const shown = targetText(write.target);
  const reach = await host.reach(write.target.repo, 'write');
  if (reach.kind === 'unreachable') {
    say(`FAILED ${shown}: ${reach.reason}; nothing was changed`);
    return false;
  }
  say(`ACCESS ${reach.access}`);
  for (const label of write.add) {
    const found = await host.labelExists(write.target.repo, label);
    if (found.kind !== 'found') {
      const why = found.kind === 'failed' ? found.reason : `${write.target.repo} has no label ${JSON.stringify(label)}: make it there first, as adding it here would make a new one`;
      say(`FAILED ${shown}: ${why}; nothing was changed`);
      return false;
    }
  }
  const done: string[] = [];
  if (write.add.length > 0) {
    const added = await host.addLabels(write.target, write.add);
    if (added.kind === 'failed') {
      say(`FAILED ${shown}: ${added.reason}; nothing was changed`);
      return false;
    }
    say(`LABELED ${shown}: ${labelsText(write.add)}`);
    done.push(`added ${labelsText(write.add)}`);
  }
  for (const label of write.remove) {
    const removed = await host.removeLabel(write.target, label);
    if (removed.kind === 'failed') {
      say(`FAILED ${shown}: ${removed.reason}${done.length === 0 ? '' : `; it already ${done.join(', ')}`}`);
      return false;
    }
    say(`UNLABELED ${shown}: ${JSON.stringify(label)}`);
    done.push(`took off ${JSON.stringify(label)}`);
  }
  return true;
}

/**
 * Why `text` may not be posted as `subject`, or undefined when it may: it is empty, too long, carries a secret
 * shape or private data (a home folder path, an e-mail address: core/private-shapes.ts), or names a task id (a team's
 * own number, which means nothing on the host: posted.ts). A refusal names the shape, never the text.
 */
export function postRefusal(subject: string, text: string, scanner: SecretScanner): string | undefined {
  if (text.trim() === '') {
    return `${subject} is empty`;
  }
  if (text.length > MAX_COMMENT) {
    return `${subject} is ${text.length} characters, over the ${MAX_COMMENT} a comment may hold`;
  }
  const secret = scanner.refusal(subject, text);
  if (secret !== undefined) {
    return secret;
  }
  const shape = privateShapeIn(text);
  if (shape !== undefined) {
    return `${subject} holds private data (${shape.description}): take it out, as a post may be read by anyone`;
  }
  const named = taskIdIn(text);
  return named === undefined ? undefined : `${subject} names the task id ${named}: a task id is the team's own, so nothing posted shows one (name issues by #number)`;
}

/**
 * Writes `write` through `host`, one line said for each step: ACCESS (how the host is reached), then COMMENTED
 * and CLOSED, or FAILED with the host's reason. The host is reached before any write, so a key that cannot be
 * read writes nothing; a failed comment closes nothing, and a close that fails after its comment says so, so a
 * rerun does not post the comment twice. True when every step was done.
 */
export async function writeIssue(host: IssueHost, write: IssueWrite, say: (line: string) => void): Promise<boolean> {
  const shown = targetText(write.target);
  const reach = await host.reach(write.target.repo, 'write');
  if (reach.kind === 'unreachable') {
    say(`FAILED ${shown}: ${reach.reason}; nothing was written`);
    return false;
  }
  say(`ACCESS ${reach.access}`);
  if (write.comment !== undefined) {
    const commented = await host.comment(write.target, write.comment);
    if (commented.kind === 'failed') {
      say(`FAILED ${shown}: ${commented.reason}${write.close ? '; it was not closed' : ''}`);
      return false;
    }
    say(`COMMENTED ${shown}`);
  }
  if (!write.close) {
    return true;
  }
  const closed = await host.close(write.target, write.reason);
  if (closed.kind === 'failed') {
    const rerun = write.comment === undefined ? '' : `; the comment was posted: rerun ${KIT_NAME} issue close ${shown} without --comment`;
    say(`FAILED ${shown}: ${closed.reason}${rerun}`);
    return false;
  }
  say(`CLOSED ${shown}${write.reason === undefined ? '' : ` as ${write.reason}`}`);
  return true;
}
