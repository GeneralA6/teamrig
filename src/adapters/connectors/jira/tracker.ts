import {
  isClaim,
  isRecord,
  isStringArray,
  recordField,
  stampCredit,
  stringField,
  type CloseReason,
  type HostAssignee,
  type HostComments,
  type HostEnd,
  type HostIssue,
  type HostIssueId,
  type HostIssueLabels,
  type HostLabel,
  type HostLinks,
  type HostList,
  type HostOpen,
  type HostReach,
  type HostThread,
  type HostUse,
  type HostViewer,
  type HostWatch,
  type IssueComment,
  type IssueDraft,
  type IssueTarget,
  type IssueThread,
  type JsonRecord,
  type LabelSpec,
  type ReadComment,
  type Tracker,
  type WatchMarks,
} from '../../../plugin-api/index.ts';
import { adfText, textAdf, type AdfDoc } from './adf.ts';
import type { JiraAnswer, JiraClient } from './client.ts';
import { NOT_BUILT } from './declaration.ts';
import { openableNames, openingType } from './issue-type.ts';
import { stateReasonOf } from './resolution.ts';
import { browseUrl, credentialName, issueKey, issueNumber, parseProject, projectProblem, type JiraProject } from './site.ts';
import { closingStep, isDoneStatus } from './transitions.ts';

/**
 * Jira Cloud as a tracker (the plugin API's Tracker port): a list is pages of one search, a look for a change one
 * search of one issue, and each write one REST call, all signed in with the site's saved credential (client.ts). What
 * Jira answers is outside input: every field is narrowed before use, and an issue or comment that does not read is
 * left out, never guessed. Each text it posts carries the made-with footer as its last paragraph when `stamp` is on.
 * The methods of a later slice answer their NOT_BUILT line and send nothing.
 */

/** The issues one page of a list asks for: the most Jira's search gives at once. */
export const PAGE_SIZE = 100;

/** The pages one list reads at most, so a search that never ends cannot hold a run: past it the list says it may leave some out. */
export const MAX_PAGES = 50;

/** The comments one read of an issue's new comments asks for: one bounded page, the newest. */
export const COMMENT_PAGE = 100;

/** The fields a list asks of each issue: what a HostIssue is made of, and nothing else. */
const LIST_FIELDS = ['summary', 'description', 'status', 'resolution', 'labels', 'assignee', 'reporter', 'updated', 'created', 'resolutiondate', 'statuscategorychangedate', 'comment'] as const;

/** The fields a read of one issue as it is now asks for: what an IssueThread is made of, and nothing else. */
const THREAD_FIELDS = ['description', 'status', 'labels', 'assignee'] as const;

/** The one mark a watch keeps: the issue changed last, and when. */
const NEWEST = 'newest';

/** The mark of a project with no issue. */
const NO_ISSUE = 'none';

/** What each use does with a sign-in, as its ACCESS line words it: the words every tracker's line uses. */
const USE_VERB: Readonly<Record<HostUse, string>> = { read: 'read with', open: 'opens issues with', write: 'writes with' };

const MS_PER_DAY = 86_400_000;

/** A day as the port gives it. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An issue's id as Jira writes it: digits, few enough that the number they make is exact. */
const ISSUE_ID = /^\d{1,15}$/;

type Failed = { readonly kind: 'failed'; readonly reason: string };

function failed(reason: string): Failed {
  return { kind: 'failed', reason };
}

/** A project's issue as a request names it, with the words a failure names it by. */
interface Place {
  readonly project: JiraProject;
  readonly key: string;
}

/** `value` as an ISO time, or undefined when it is no time. Jira writes `2026-11-20T15:48:00.000+0200`, which Date reads. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The day before `day` (`YYYY-MM-DD`), or undefined when `day` is no day. */
function dayBefore(day: string): string | undefined {
  const ms = DAY.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms - MS_PER_DAY).toISOString().slice(0, 10);
}

/** A Jira user's account id, empty when the answer names none (an anonymous reporter, a deleted account). */
function accountId(user: JsonRecord | undefined): string {
  return (user === undefined ? undefined : stringField(user, 'accountId')) ?? '';
}

/** The field `name` of one issue as a read of it answers, when the answer holds an object there. */
function issueField(body: unknown, name: string): JsonRecord | undefined {
  const fields = isRecord(body) ? recordField(body, 'fields') : undefined;
  return fields === undefined ? undefined : recordField(fields, name);
}

/**
 * What kind of account a Jira user is, in the port's words: a person (a customer of a service desk is one) or an app.
 * Empty for any other, which core reads as no person.
 */
function accountKind(user: JsonRecord | undefined): string {
  switch (user === undefined ? undefined : stringField(user, 'accountType')) {
    case 'atlassian':
    case 'customer':
      return 'User';
    case 'app':
      return 'Bot';
    default:
      return '';
  }
}

/**
 * A comment as a list or a comment read gives it, or undefined when it does not read as one. Its tie to the project is
 * empty: Jira names none, and an empty tie reads as an outsider's, never a member's.
 */
function commentOf(value: unknown): IssueComment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const at = isoTime(value['created']);
  const author = recordField(value, 'author');
  return at === undefined ? undefined : { at, login: accountId(author), authorAssociation: '', authorKind: accountKind(author) };
}

function oldestFirst<T extends IssueComment>(comments: readonly T[]): T[] {
  return [...comments].sort((a, b) => a.at.localeCompare(b.at));
}

/** The comments a listed issue carries, oldest first. */
function listedComments(fields: JsonRecord): IssueComment[] {
  const comments: unknown = recordField(fields, 'comment')?.['comments'];
  return oldestFirst((Array.isArray(comments) ? comments : []).flatMap((value: unknown) => commentOf(value) ?? []));
}

/**
 * One issue of a search as the import reads it, or undefined when it does not read as an issue of `project`.
 * No label event and no tie of the reporter to the project is given, so core takes none of these issues on trust:
 * an accept label counts only by the event of who put it on.
 */
function hostIssue(repo: string, project: JiraProject, value: unknown): HostIssue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const key = stringField(value, 'key');
  const number = key === undefined ? undefined : issueNumber(project, key);
  const fields = recordField(value, 'fields');
  if (number === undefined || fields === undefined) {
    return undefined;
  }
  const closed = isDoneStatus(recordField(fields, 'status'));
  const resolution = recordField(fields, 'resolution');
  const reporter = recordField(fields, 'reporter');
  const labels: unknown = fields['labels'];
  const assignee = accountId(recordField(fields, 'assignee'));
  return {
    repo,
    number,
    title: stringField(fields, 'summary') ?? '',
    body: adfText(fields['description']),
    state: closed ? 'closed' : 'open',
    stateReason: closed && resolution !== undefined ? stateReasonOf(stringField(resolution, 'name') ?? '') : '',
    labels: isStringArray(labels) ? labels : [],
    assignees: assignee === '' ? [] : [assignee],
    url: browseUrl(project, number),
    updatedAt: isoTime(fields['updated']),
    closedAt: closed ? (isoTime(fields['statuscategorychangedate']) ?? isoTime(fields['resolutiondate'])) : undefined,
    lastEditedAt: undefined,
    authorAssociation: '',
    author: accountId(reporter),
    authorKind: accountKind(reporter),
    labelEvents: [],
    renamedAt: undefined,
    createdAt: isoTime(fields['created']),
    comments: listedComments(fields),
    linkedPulls: 0,
  };
}

/**
 * One issue as a read of it alone gives it, or undefined when the answer does not read as one: a write is matched to
 * this state, so an answer with no status or no list of labels is no issue here, never an open one with no label.
 * A Jira issue is never a pull request.
 */
function issueThread(body: unknown): IssueThread | undefined {
  const fields = isRecord(body) ? recordField(body, 'fields') : undefined;
  const status = fields === undefined ? undefined : recordField(fields, 'status');
  const labels: unknown = fields?.['labels'];
  if (fields === undefined || status === undefined || !isStringArray(labels)) {
    return undefined;
  }
  const assignee = accountId(recordField(fields, 'assignee'));
  return {
    state: isDoneStatus(status) ? 'closed' : 'open',
    labels,
    assignees: assignee === '' ? [] : [assignee],
    pull: false,
    body: adfText(fields['description']),
  };
}

/** One read comment, or undefined when it does not read as one or was neither posted nor edited at or after `since`. */
function readComment(value: unknown, since: number): ReadComment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const comment = commentOf(value);
  if (comment === undefined) {
    return undefined;
  }
  const changed = Date.parse(isoTime(value['updated']) ?? comment.at);
  return changed >= since ? { ...comment, claims: isClaim(adfText(value['body'])) } : undefined;
}

/** A Jira label holds no space: the name as it would be refused, or undefined for one Jira can hold. */
function labelProblem(label: string): string | undefined {
  return label === '' || /\s/.test(label) ? `${JSON.stringify(label)} cannot be a Jira label: one holds no space` : undefined;
}

/** What an open answers when the project has no type of the name the team's config asks for: the ones it has, to pick from. */
function noSuchType(project: JiraProject, wanted: string, has: readonly string[]): string {
  const names = has.length === 0 ? 'none' : has.join(', ');
  return `${project.key} has no issue type ${JSON.stringify(wanted)} the sign-in may open an issue as (it has ${names}): name one of them in connectors.jira.issueType`;
}

export class JiraTracker implements Tracker {
  readonly name = 'Jira';
  private readonly client: JiraClient;
  private readonly stamp: boolean;
  /** The id of the type a new issue opens as, by project (`<site>/<KEY>`). */
  private readonly openingTypes = new Map<string, string>();
  /** The type the team's config names for a new issue (`connectors.jira.issueType`), or undefined for the tracker's own pick. */
  private readonly issueType: string | undefined;

  constructor(client: JiraClient, stamp: boolean, issueType?: string) {
    this.client = client;
    this.stamp = stamp;
    this.issueType = issueType;
  }

  /** Reached with the site's saved sign-in only; the scope is the site, as one sign-in serves all its projects. */
  async reach(repo: string, use: HostUse): Promise<HostReach> {
    const project = parseProject(repo);
    if (project === undefined) {
      return { kind: 'unreachable', reason: projectProblem(repo) };
    }
    const signIn = await this.client.signIn(project.site);
    return signIn.kind === 'failed'
      ? { kind: 'unreachable', reason: signIn.reason }
      : { kind: 'reached', access: `${project.site}: ${USE_VERB[use]} the API token saved as ${credentialName(project.site)}`, scope: project.site };
  }

  /**
   * The project's open issues and those closed on or after `closedSince`, page by page. Jira reads a day of a search
   * in the account's own time zone, so the search asks from a day earlier and the closed ones are cut to the UTC day
   * here. When a page fails nothing of the project is given, so its tasks are not judged on half a read.
   */
  async list(repo: string, closedSince: string): Promise<HostList> {
    const project = parseProject(repo);
    if (project === undefined) {
      return failed(projectProblem(repo));
    }
    const from = dayBefore(closedSince);
    if (from === undefined) {
      return failed(`${JSON.stringify(closedSince)} is not a day (YYYY-MM-DD)`);
    }
    const jql = `project = "${project.key}" AND (statusCategory != Done OR statusCategoryChangedDate >= "${from}")`;
    const closedFrom = `${closedSince}T00:00:00.000Z`;
    const issues: HostIssue[] = [];
    let unreadable = 0;
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await this.client.post(project.site, '/search/jql', { jql, fields: LIST_FIELDS, maxResults: PAGE_SIZE, ...(token === undefined ? {} : { nextPageToken: token }) });
      const body = this.searched(repo, answer);
      if (body.kind === 'failed') {
        return body;
      }
      for (const item of body.issues) {
        const issue = hostIssue(repo, project, item);
        if (issue === undefined) {
          unreadable += 1;
        } else if (issue.closedAt === undefined || issue.closedAt >= closedFrom) {
          issues.push(issue);
        }
      }
      token = body.next;
      if (token === undefined) {
        break;
      }
    }
    return {
      kind: 'listed',
      issues,
      notes: [
        ...(token === undefined ? [] : [`the list reached ${MAX_PAGES * PAGE_SIZE} issues, so it may leave some out`]),
        ...(unreadable > 0 ? [`${unreadable} item(s) Jira listed did not read as issues of ${project.key} and were left out`] : []),
      ],
    };
  }

  /**
   * Opens one issue of the project: the title its summary, the body its description as plain paragraphs (left out when
   * it holds no line), the labels as given. Its type is the one issue-type.ts picks of the project's own. A blank
   * title, or a label Jira cannot hold, is refused before anything is asked.
   */
  async open(draft: IssueDraft): Promise<HostOpen> {
    const project = parseProject(draft.repo);
    if (project === undefined) {
      return failed(projectProblem(draft.repo));
    }
    const [problem] = [...(draft.title.trim() === '' ? ['an issue with no title is not opened'] : []), ...draft.labels.flatMap((label) => labelProblem(label) ?? [])];
    if (problem !== undefined) {
      return failed(problem);
    }
    const type = await this.openingTypeOf(project);
    if (type.kind === 'failed') {
      return type;
    }
    const description = this.document(draft.body);
    const fields = {
      project: { key: project.key },
      summary: draft.title,
      issuetype: { id: type.id },
      ...(draft.labels.length === 0 ? {} : { labels: draft.labels }),
      ...(description.content.length === 0 ? {} : { description }),
    };
    const answer = await this.client.post(project.site, '/issue', { fields });
    if (answer.kind !== 'ok') {
      return answer.kind === 'missing' ? failed(this.noProject(project)) : answer;
    }
    const key = isRecord(answer.body) ? stringField(answer.body, 'key') : undefined;
    const number = key === undefined ? undefined : issueNumber(project, key);
    return number === undefined
      ? failed(`Jira opened an issue of ${draft.repo} and its answer names no issue of ${project.key}: find it on the site before opening another`)
      : { kind: 'opened', target: { repo: draft.repo, number } };
  }

  /** Replaces the description with `body` as plain paragraphs. */
  async editBody(target: IssueTarget, body: string): Promise<HostEnd> {
    return await this.write(target, (place) => this.client.put(place.project.site, `/issue/${place.key}`, { fields: { description: this.document(body) } }));
  }

  /**
   * Closes the issue by a transition its workflow offers from its status (transitions.ts), for `reason`, or as
   * completed when none is given. An issue already closed is left as it is, with nothing written. A duplicate is
   * closed as one, and no link to its original is made.
   */
  async close(target: IssueTarget, reason?: CloseReason): Promise<HostEnd> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const issue = await this.read(target, place, '?fields=status');
    if (issue.kind === 'failed') {
      return issue;
    }
    if (isDoneStatus(issueField(issue.body, 'status'))) {
      return { kind: 'done' };
    }
    const offered = await this.read(target, place, '/transitions?expand=transitions.fields');
    if (offered.kind === 'failed') {
      return offered;
    }
    const step = closingStep(offered.body, reason ?? 'completed');
    if (step === undefined) {
      return failed(`Jira offers no transition that closes ${place.key}: its workflow has none from the issue's status that the sign-in may make`);
    }
    const sent = { transition: { id: step.id }, ...(step.resolution === undefined ? {} : { fields: { resolution: { id: step.resolution } } }) };
    return await this.write(target, (at) => this.client.post(at.project.site, `/issue/${at.key}/transitions`, sent));
  }

  /**
   * Jira's own id of the issue, which it writes as a string of digits. Core reads it of the original a duplicate's
   * close names, so that close is refused for an original Jira does not show; no link is made by it.
   */
  async issueId(target: IssueTarget): Promise<HostIssueId> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const answer = await this.client.get(place.project.site, `/issue/${place.key}?fields=summary`);
    if (answer.kind !== 'ok') {
      return answer;
    }
    const id = isRecord(answer.body) ? stringField(answer.body, 'id') : undefined;
    return id !== undefined && ISSUE_ID.test(id) ? { kind: 'found', id: Number(id) } : failed(`Jira's answer for ${place.key} names no id for the issue`);
  }

  /**
   * The issue as it is now, by one read of it: its state by its status, its labels, the account holding it and its
   * description as plain text. An issue Jira does not show is missing, as for its id.
   */
  async thread(target: IssueTarget): Promise<HostThread> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const answer = await this.client.get(place.project.site, `/issue/${place.key}?fields=${THREAD_FIELDS.join(',')}`);
    if (answer.kind !== 'ok') {
      return answer;
    }
    const thread = issueThread(answer.body);
    return thread === undefined ? failed(`Jira's answer for ${place.key} did not read as an issue`) : { kind: 'read', thread };
  }

  /** Posts `body` as one comment of plain paragraphs. A text with no line is refused here: Jira takes no empty comment. */
  async comment(target: IssueTarget, body: string): Promise<HostEnd> {
    if (textAdf(body).content.length === 0) {
      return failed('an empty comment is not posted');
    }
    return await this.write(target, (place) => this.client.post(place.project.site, `/issue/${place.key}/comment`, { body: this.document(body) }));
  }

  /** The newest page of the issue's comments, kept when posted or edited at or after `since`; each text is matched for a claim line and dropped. */
  async newComments(target: IssueTarget, since: number): Promise<HostComments> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const answer = await this.client.get(place.project.site, `/issue/${place.key}/comment?orderBy=-created&maxResults=${COMMENT_PAGE}`);
    if (answer.kind !== 'ok') {
      return answer.kind === 'missing' ? failed(this.noIssue(target, place)) : answer;
    }
    const comments: unknown = isRecord(answer.body) ? answer.body['comments'] : undefined;
    if (!Array.isArray(comments)) {
      return failed(`Jira's answer for the comments of ${place.key} did not read as a list of comments`);
    }
    return { kind: 'read', comments: oldestFirst(comments.flatMap((value: unknown) => readComment(value, since) ?? [])) };
  }

  /** A Jira label holds no space, so each run of white space in a name is held as one hyphen: `status:in progress` as `status:in-progress`. */
  labelName(label: string): string {
    return label.replace(/\s+/gu, '-');
  }

  /** A Jira label is not made ahead: it exists once an issue carries it. So any name Jira can hold is found, with no request. */
  labelExists(repo: string, label: string): Promise<HostLabel> {
    const problem = parseProject(repo) === undefined ? projectProblem(repo) : labelProblem(label);
    return Promise.resolve(problem === undefined ? { kind: 'found' } : failed(problem));
  }

  /** Nothing to make (labelExists); a label's colour and description have no place in Jira. */
  createLabel(repo: string, label: LabelSpec): Promise<HostEnd> {
    const problem = parseProject(repo) === undefined ? projectProblem(repo) : labelProblem(label.name);
    return Promise.resolve(problem === undefined ? { kind: 'done' } : failed(problem));
  }

  async addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd> {
    const [problem] = labels.flatMap((label) => labelProblem(label) ?? []);
    if (problem !== undefined) {
      return failed(problem);
    }
    if (labels.length === 0) {
      return this.nothingToWrite(target);
    }
    return await this.write(target, (place) => this.client.put(place.project.site, `/issue/${place.key}`, { update: { labels: labels.map((label) => ({ add: label })) } }));
  }

  /** Takes `label` off. A name Jira cannot hold is on no issue, so that is done with no request. */
  async removeLabel(target: IssueTarget, label: string): Promise<HostEnd> {
    if (labelProblem(label) !== undefined) {
      return this.nothingToWrite(target);
    }
    return await this.write(target, (place) => this.client.put(place.project.site, `/issue/${place.key}`, { update: { labels: [{ remove: label }] } }));
  }

  async issueLabels(target: IssueTarget): Promise<HostIssueLabels> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const answer = await this.client.get(place.project.site, `/issue/${place.key}?fields=labels`);
    if (answer.kind !== 'ok') {
      return answer;
    }
    const labels: unknown = isRecord(answer.body) ? recordField(answer.body, 'fields')?.['labels'] : undefined;
    return isStringArray(labels) ? { kind: 'read', labels } : failed(`Jira's answer for the labels of ${place.key} did not read as a list of labels`);
  }

  /** Whether the account `login` names may be assigned in the project. */
  async assigneeExists(repo: string, login: string): Promise<HostAssignee> {
    const project = parseProject(repo);
    if (project === undefined) {
      return failed(projectProblem(repo));
    }
    return await this.assignable(project.site, `project=${project.key}`, login, this.noProject(project));
  }

  /** The account the site's sign-in belongs to, by its account id: Jira's users have no login, and the id is what an assign names. */
  async viewer(repo: string): Promise<HostViewer> {
    const project = parseProject(repo);
    if (project === undefined) {
      return failed(projectProblem(repo));
    }
    const answer = await this.client.get(project.site, '/myself');
    if (answer.kind !== 'ok') {
      return answer.kind === 'missing' ? failed(`Jira on ${project.site} does not say whose sign-in it is`) : answer;
    }
    const id = isRecord(answer.body) ? accountId(answer.body) : '';
    return id === '' ? failed(`Jira's answer on ${project.site} names no account for the sign-in`) : { kind: 'found', login: id };
  }

  /** Whether the account `login` names may be assigned to the issue. */
  async assignableOn(target: IssueTarget, login: string): Promise<HostAssignee> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    return await this.assignable(place.project.site, `issueKey=${place.key}`, login, this.noIssue(target, place));
  }

  /**
   * Gives the issue to the one account `logins` names. A Jira issue holds one assignee, so this replaces who held it,
   * and more than one account is refused with nothing written.
   */
  async assign(target: IssueTarget, logins: readonly string[]): Promise<HostEnd> {
    const accounts = [...new Set(logins)];
    const [account] = accounts;
    if (account === undefined) {
      return this.nothingToWrite(target);
    }
    if (accounts.length > 1) {
      return failed(`a Jira issue holds one assignee, so it cannot take ${accounts.length} at once: name one account`);
    }
    if (account === '') {
      return failed('an empty account id names no one to assign');
    }
    return await this.write(target, (place) => this.client.put(place.project.site, `/issue/${place.key}/assignee`, { accountId: account }));
  }

  /** Takes the account `login` names off when it holds the issue; another holder stays, with nothing written. */
  async unassign(target: IssueTarget, login: string): Promise<HostEnd> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    if (login === '') {
      return { kind: 'done' };
    }
    const issue = await this.read(target, place, '?fields=assignee');
    if (issue.kind === 'failed') {
      return issue;
    }
    if (accountId(issueField(issue.body, 'assignee')) !== login) {
      return { kind: 'done' };
    }
    return await this.write(target, (at) => this.client.put(at.project.site, `/issue/${at.key}/assignee`, { accountId: null }));
  }

  links(): Promise<HostLinks> {
    return Promise.resolve(failed(NOT_BUILT.links));
  }

  addSubIssue(): Promise<HostEnd> {
    return Promise.resolve(failed(NOT_BUILT.links));
  }

  addBlockedBy(): Promise<HostEnd> {
    return Promise.resolve(failed(NOT_BUILT.links));
  }

  /**
   * Whether the project changed, by one search of its issue changed last: any change to an issue (a comment too) moves
   * its `updated`, so the mark is that issue's id and time. Each look is a request, which counts against the site's
   * rate limit; an issue deleted while another stays the newest is not seen.
   */
  async watch(repo: string, marks: WatchMarks): Promise<HostWatch> {
    const project = parseProject(repo);
    if (project === undefined) {
      return failed(projectProblem(repo));
    }
    const answer = await this.client.post(project.site, '/search/jql', { jql: `project = "${project.key}" ORDER BY updated DESC`, fields: ['updated'], maxResults: 1 });
    const body = this.searched(repo, answer);
    if (body.kind === 'failed') {
      return body;
    }
    const [newest] = body.issues;
    const mark = newest === undefined ? NO_ISSUE : this.markOf(newest);
    if (mark === undefined) {
      return failed(`Jira's answer for ${repo} names no time for the issue changed last`);
    }
    return marks.get(NEWEST) === mark ? { kind: 'unchanged' } : { kind: 'changed', marks: new Map([[NEWEST, mark]]) };
  }

  /** The mark of the issue a watch found: its id, which no other issue gets, and when it last changed. */
  private markOf(issue: unknown): string | undefined {
    const id = isRecord(issue) ? stringField(issue, 'id') : undefined;
    const updated = isRecord(issue) ? stringField(recordField(issue, 'fields') ?? {}, 'updated') : undefined;
    return id === undefined || updated === undefined ? undefined : `${id}@${updated}`;
  }

  /** The issues of one search answer and the token of its next page, or why it gave none. */
  private searched(repo: string, answer: JiraAnswer): { readonly kind: 'page'; readonly issues: readonly unknown[]; readonly next: string | undefined } | Failed {
    if (answer.kind === 'failed') {
      return answer;
    }
    const body = answer.kind === 'ok' && isRecord(answer.body) ? answer.body : undefined;
    const issues: unknown = body?.['issues'];
    if (body === undefined || !Array.isArray(issues)) {
      return failed(`Jira's answer to the search of ${repo} did not read as a list of issues`);
    }
    const next = stringField(body, 'nextPageToken');
    return { kind: 'page', issues, next: next === '' ? undefined : next };
  }

  /**
   * Whether the account `login` names may be assigned where `scope` says, a project or one issue: Jira's users have no
   * login, so the port's login is an account id. One read of who may be assigned there, narrowed to that account; an
   * empty id names no one, with no request. `nowhere` is the failure when Jira does not show the project or the issue.
   */
  private async assignable(site: string, scope: string, login: string, nowhere: string): Promise<HostAssignee> {
    if (login === '') {
      return { kind: 'missing' };
    }
    const answer = await this.client.get(site, `/user/assignable/search?${scope}&accountId=${encodeURIComponent(login)}`);
    if (answer.kind !== 'ok') {
      return answer.kind === 'missing' ? failed(nowhere) : answer;
    }
    if (!Array.isArray(answer.body)) {
      return failed(`Jira's answer on who may be assigned on ${site} did not read as a list of accounts`);
    }
    return answer.body.some((user: unknown) => isRecord(user) && accountId(user) === login) ? { kind: 'found', login } : { kind: 'missing' };
  }

  /**
   * The type a new issue of `project` opens as: one read of the types the project lets the sign-in create, kept for
   * the tracker's life so a run that opens several issues asks once. A failed read is not kept.
   */
  private async openingTypeOf(project: JiraProject): Promise<{ readonly kind: 'type'; readonly id: string } | Failed> {
    const name = `${project.site}/${project.key}`;
    const kept = this.openingTypes.get(name);
    if (kept !== undefined) {
      return { kind: 'type', id: kept };
    }
    const answer = await this.client.get(project.site, `/issue/createmeta/${project.key}/issuetypes`);
    if (answer.kind !== 'ok') {
      return answer.kind === 'missing' ? failed(this.noProject(project)) : answer;
    }
    const id = openingType(answer.body, this.issueType);
    if (id === undefined) {
      return failed(this.issueType === undefined ? `Jira names no issue type the sign-in may open an issue of ${project.key} as` : noSuchType(project, this.issueType, openableNames(answer.body)));
    }
    this.openingTypes.set(name, id);
    return { kind: 'type', id };
  }

  private noProject(project: JiraProject): string {
    return `Jira has no project ${project.key} on ${project.site}, or the sign-in may not see it`;
  }

  /** The issue `target` names, or the failure of a `repo` that names no project. */
  private place(target: IssueTarget): ({ readonly kind: 'place' } & Place) | Failed {
    const project = parseProject(target.repo);
    return project === undefined ? failed(projectProblem(target.repo)) : { kind: 'place', project, key: issueKey(project, target.number) };
  }

  private noIssue(target: IssueTarget, place: Place): string {
    return `Jira has no issue ${place.key} on ${place.project.site} (${target.repo}#${target.number}), or the sign-in may not see it`;
  }

  /** A write that has nothing to send: done, when `target` names a project at all. */
  private nothingToWrite(target: IssueTarget): HostEnd {
    const place = this.place(target);
    return place.kind === 'failed' ? place : { kind: 'done' };
  }

  /** One read of an issue, `path` going after its key: Jira's answer, or why there is none. An issue Jira does not show is a failure here. */
  private async read(target: IssueTarget, place: Place, path: string): Promise<{ readonly kind: 'ok'; readonly body: unknown } | Failed> {
    const answer = await this.client.get(place.project.site, `/issue/${place.key}${path}`);
    return answer.kind === 'missing' ? failed(this.noIssue(target, place)) : answer;
  }

  /** One write on an issue: done, or why not. Jira answers a write on an issue it does not show with no such thing, which is a failure here. */
  private async write(target: IssueTarget, send: (place: Place) => Promise<JiraAnswer>): Promise<HostEnd> {
    const place = this.place(target);
    if (place.kind === 'failed') {
      return place;
    }
    const answer = await send(place);
    switch (answer.kind) {
      case 'ok':
        return { kind: 'done' };
      case 'missing':
        return failed(this.noIssue(target, place));
      case 'failed':
        return answer;
    }
  }

  /** `text` as the document Jira takes, the made-with footer its last paragraph when the stamp is on. */
  private document(text: string): AdfDoc {
    return this.stamp ? textAdf(text, stampCredit()) : textAdf(text);
  }
}
