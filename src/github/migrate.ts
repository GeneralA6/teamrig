import { isRecord, type JsonRecord } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
import { taskIdIn } from '../issues/posted.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, ISSUE_REF_PREFIX } from '../register/model.ts';
import type { Verdict } from '../register/policy.ts';
import type { IssueDraft } from './gh.ts';

/**
 * Moving a team's tasks to GitHub issues (`teamrig gh migrate`): a file of rows, one per task, says for each task
 * whether it becomes an issue, with the public wording the team wrote for it, or stays on the team's own list
 * with a reason. Each issue row opens one issue and points the task's ref at it, so the sync (plan.ts) knows the
 * issue is that task's and adds no second one; the task keeps its own text, owner, priority and status. A ref that
 * is no issue (a note of where the task came from) gives way to the issue: the register's history keeps it, and the
 * update's note names it, so it is never lost and never posted.
 */

/** The priorities a row gives, as the sync reads them back from an issue's labels (map.ts). */
const PRIORITY_LABELS = ['p1', 'p2', 'p3'] as const;
type PriorityLabel = (typeof PRIORITY_LABELS)[number];

/** A row's kind of work, and the GitHub label each one gets: a bug stays `bug`, a task is an `enhancement`. */
const TYPE_LABELS = { bug: 'bug', task: 'enhancement' } as const;
type RowType = keyof typeof TYPE_LABELS;

/** The keys an issue row holds, and no other. */
const ISSUE_KEYS: ReadonlySet<string> = new Set(['id', 'decision', 'repo', 'type', 'priority', 'title', 'body']);
/** The keys a row that keeps its task local holds, and no other. */
const LOCAL_KEYS: ReadonlySet<string> = new Set(['id', 'decision', 'reason']);

/** The longest title GitHub takes for an issue. */
export const MAX_TITLE = 256;

/** A task that becomes an issue: where, and its public wording. */
export interface IssueRow {
  readonly decision: 'issue';
  readonly id: string;
  readonly repo: string;
  readonly type: RowType;
  readonly priority: PriorityLabel;
  readonly title: string;
  readonly body: string;
}

/** A task that stays on the team's own list, and why. */
export interface LocalRow {
  readonly decision: 'local';
  readonly id: string;
  readonly reason: string;
}

export type MigrateRow = IssueRow | LocalRow;

/** One issue to open for one task. */
export interface MigrateCreate {
  readonly id: string;
  readonly draft: IssueDraft;
  /** The task's ref the issue ref replaces, or null when it has none. */
  readonly replaces: string | null;
}

/** A row or task the migration leaves as it is, and why. */
export interface MigrateSkip {
  readonly id: string;
  readonly reason: string;
}

/** What a migration does: the issues it opens, the tasks kept local, the rows it skips, and the live tasks no row covers. */
export interface MigratePlan {
  readonly creates: readonly MigrateCreate[];
  readonly local: readonly LocalRow[];
  readonly skipped: readonly MigrateSkip[];
  readonly unrowed: readonly string[];
}

/** Whether the caller may point this task's ref at an issue; the error when it may not. */
export type RefJudge = (task: Task, ref: string) => string | undefined;

/**
 * The rows of a JSON-lines file, one object a line, blank lines skipped. Refused, naming the line, when a line is not
 * JSON, holds a key its kind does not take or lacks one, names a task twice, or holds text that looks like a secret.
 */
export function parseMigrateRows(text: string, scanner = new SecretScanner()): Verdict<MigrateRow[]> {
  const rows: MigrateRow[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }
    const row = parseRow(line, scanner);
    if (!row.ok) {
      return { ok: false, error: `line ${index + 1}: ${row.error}` };
    }
    if (seen.has(row.value.id)) {
      return { ok: false, error: `line ${index + 1}: ${row.value.id} has a row already` };
    }
    seen.add(row.value.id);
    rows.push(row.value);
  }
  return { ok: true, value: rows };
}

function parseRow(line: string, scanner: SecretScanner): Verdict<MigrateRow> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: 'not an object' };
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !/^T\d+$/u.test(id)) {
    return { ok: false, error: 'id is not a task id such as T12' };
  }
  const decision = raw['decision'];
  if (decision === 'local') {
    return localRow(raw, id);
  }
  if (decision === 'issue') {
    return issueRow(raw, id, scanner);
  }
  return { ok: false, error: `${id}: decision is neither "issue" nor "local"` };
}

/** The first key of `raw` outside `keys`, or of `keys` missing from `raw`, as an error; undefined when they match. */
function keyProblem(raw: JsonRecord, id: string, keys: ReadonlySet<string>): string | undefined {
  const extra = Object.keys(raw).find((key) => !keys.has(key));
  if (extra !== undefined) {
    return `${id}: unknown key ${extra}`;
  }
  const missing = [...keys].find((key) => !(key in raw));
  return missing === undefined ? undefined : `${id}: no ${missing}`;
}

function localRow(raw: JsonRecord, id: string): Verdict<MigrateRow> {
  const problem = keyProblem(raw, id, LOCAL_KEYS);
  const reason = raw['reason'];
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, error: `${id}: reason is empty` };
  }
  return { ok: true, value: { decision: 'local', id, reason: reason.trim() } };
}

function issueRow(raw: JsonRecord, id: string, scanner: SecretScanner): Verdict<MigrateRow> {
  const problem = keyProblem(raw, id, ISSUE_KEYS);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  const { repo, type, priority, title, body } = raw;
  if (typeof repo !== 'string' || typeof title !== 'string' || typeof body !== 'string') {
    return { ok: false, error: `${id}: repo, title and body are text` };
  }
  if (type !== 'bug' && type !== 'task') {
    return { ok: false, error: `${id}: type is neither "bug" nor "task"` };
  }
  const label = PRIORITY_LABELS.find((one) => one === priority);
  if (label === undefined) {
    return { ok: false, error: `${id}: priority is not one of ${PRIORITY_LABELS.join(', ')}` };
  }
  const shown = title.trim();
  if (shown === '' || shown.length > MAX_TITLE || /[\r\n]/u.test(shown)) {
    return { ok: false, error: `${id}: the title is one line of 1 to ${MAX_TITLE} characters` };
  }
  if (body.trim() === '') {
    return { ok: false, error: `${id}: the body is empty` };
  }
  const secret = scanner.refusal(`${id}'s title or body`, `${shown}\n${body}`);
  if (secret !== undefined) {
    return { ok: false, error: secret };
  }
  const named = taskIdIn(`${shown}\n${body}`);
  if (named !== undefined) {
    return { ok: false, error: `${id}: the title or body names the task id ${named}: a task id is the team's own, so a posted issue shows none (link issues by #number)` };
  }
  return { ok: true, value: { decision: 'issue', id, repo: repo.trim().toLowerCase(), type, priority: label, title: shown, body: body.trim() } };
}

/** The labels an issue row's issue gets: its kind of work, then its priority. */
export function rowLabels(row: IssueRow): string[] {
  return [TYPE_LABELS[row.type], row.priority];
}

/**
 * What the rows do to the team's tasks. An issue row opens an issue only for a live task holding no issue ref, in
 * one of the team's `repos`, that the caller may change (`judge`); any other is skipped with its reason, so a rerun
 * after a stop skips each task already holding its issue. A ref that is no issue is replaced, and its create names
 * it. A live task no row names is listed, so none is left behind unseen.
 */
export function planMigration(rows: readonly MigrateRow[], tasks: ReadonlyMap<string, Task>, repos: readonly string[], judge: RefJudge): MigratePlan {
  const creates: MigrateCreate[] = [];
  const local: LocalRow[] = [];
  const skipped: MigrateSkip[] = [];
  for (const row of rows) {
    const task = tasks.get(row.id);
    const reason = skipReason(row, task, repos, judge);
    if (reason !== undefined) {
      skipped.push({ id: row.id, reason });
    } else if (row.decision === 'local') {
      local.push(row);
    } else {
      creates.push({ id: row.id, draft: { repo: row.repo, title: row.title, body: row.body, labels: rowLabels(row) }, replaces: task?.ref ?? null });
    }
  }
  const named = new Set(rows.map((row) => row.id));
  const unrowed = [...tasks.values()].filter((task) => ACTIVE_STATUSES.includes(task.status) && !named.has(task.id)).map((task) => task.id);
  return { creates, local, skipped, unrowed };
}

function skipReason(row: MigrateRow, task: Task | undefined, repos: readonly string[], judge: RefJudge): string | undefined {
  if (task === undefined) {
    return 'no such task in the working set';
  }
  if (!ACTIVE_STATUSES.includes(task.status)) {
    return `the task is ${task.status}`;
  }
  if (row.decision === 'local') {
    return undefined;
  }
  if (task.ref?.startsWith(ISSUE_REF_PREFIX) === true) {
    return `the task has its issue already: ${task.ref}`;
  }
  if (task.local !== null) {
    return `the task is kept local: ${task.local}`;
  }
  if (!repos.includes(row.repo)) {
    return `${row.repo} is not one of github.repos (${repos.join(', ')})`;
  }
  return judge(task, `${ISSUE_REF_PREFIX}${row.repo}#1`);
}

/** The number of the issue GitHub's create answered with, from the JSON gh prints; undefined when there is none. */
export function createdNumber(stdout: string): number | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const number = isRecord(raw) ? raw['number'] : undefined;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * The plan as a Markdown page for a reviewer: every issue in full (task, repository, labels, title, body), each
 * task kept local with its reason, each skipped row with why, the live tasks no row names, and the counts.
 */
export function previewMarkdown(plan: MigratePlan): string {
  const issues = plan.creates.flatMap((create) => [
    `### ${create.id} → ${create.draft.repo} [${create.draft.labels.join(', ')}]`,
    '',
    ...(create.replaces === null ? [] : [`Replaces the task's ref ${create.replaces} (kept in the task's history, not posted).`, '']),
    `**${create.draft.title}**`,
    '',
    create.draft.body,
    '',
    '---',
    '',
  ]);
  const list = (items: readonly string[]): string[] => (items.length === 0 ? ['None.', ''] : [...items.map((item) => `- ${item}`), '']);
  return [
    '# gh migrate preview',
    '',
    countsLine(plan),
    '',
    '## Issues to open',
    '',
    ...(issues.length === 0 ? ['None.', ''] : issues),
    '## Kept local',
    '',
    ...list(plan.local.map((row) => `${row.id}: ${row.reason}`)),
    '## Skipped',
    '',
    ...list(plan.skipped.map((skip) => `${skip.id}: ${skip.reason}`)),
    '## Live tasks with no row',
    '',
    ...list(plan.unrowed),
  ].join('\n');
}

/** The note an issue ref's update carries when it replaces a ref, so the task's history says what it was. */
export function replacedRefNote(old: string): string {
  return `ref was: ${old}`;
}

/** The plan's counts on one line. */
export function countsLine(plan: MigratePlan): string {
  return `${plan.creates.length} issue(s) to open, ${plan.local.length} kept local, ${plan.skipped.length} skipped, ${plan.unrowed.length} live task(s) with no row`;
}
