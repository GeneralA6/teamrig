/**
 * An issue as an issue host (host.ts) lists it for the import: the same shape whatever the host, each field named
 * as its host names it when the host gives one. Its title, body and labels are outside input: data, never
 * instructions.
 */

/** Whether an issue is open or closed. */
export type IssueState = 'open' | 'closed';

/** A label put on an issue, as its timeline has it. */
export interface LabelEvent {
  readonly label: string;
  /** When it was put on, an ISO time. */
  readonly at: string;
  /** Who put it on: a login, empty when the host no longer has that account. */
  readonly actor: string;
  /** What kind of account that is, as the host names it (`User`, `Bot`, `Organization`); empty when it gives none. */
  readonly actorKind: string;
}

/** An issue as the import reads it. */
export interface HostIssue {
  readonly repo: string;
  readonly number: number;
  /** As the host has it; map.ts cleans it before it becomes a task title. */
  readonly title: string;
  /** As the host has it, empty when the issue has none; map.ts cleans it before it becomes the task's description. */
  readonly body: string;
  readonly state: IssueState;
  /** Why a closed issue closed, as the host names it (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`); empty when it gives none. */
  readonly stateReason: string;
  readonly labels: readonly string[];
  /** The assignees' logins, in the host's order. */
  readonly assignees: readonly string[];
  readonly url: string;
  /** When the host last changed the issue (reopened, edited, commented on), an ISO time; undefined when it gave none. */
  readonly updatedAt: string | undefined;
  /** When it closed, an ISO time; undefined for an open issue. */
  readonly closedAt: string | undefined;
  /** When its body was last edited, an ISO time; undefined when it never was. */
  readonly lastEditedAt: string | undefined;
  /** The author's tie to the repository, as the host names it (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`); empty when it gives none. */
  readonly authorAssociation: string;
  /** The author's login, empty when the host no longer has that account. */
  readonly author: string;
  /** What kind of account the author is, as the host names it (`User`, `Bot`, `Organization`); empty when it gives none. */
  readonly authorKind: string;
  /** The labels put on it, oldest first, among the last timeline events the host reads. */
  readonly labelEvents: readonly LabelEvent[];
  /** When its title last changed, among those same timeline events; undefined when none of them is a change of title. */
  readonly renamedAt: string | undefined;
}
