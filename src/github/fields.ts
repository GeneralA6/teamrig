import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { FieldKind, FieldValue, FieldedIssue, HostField, HostFieldRead } from '../issues/fields.ts';
import { HOST_ID, type GhRunner } from './gh.ts';
import { ISSUE_READ, nodesOf, plainLine, runRead } from './issues.ts';
import { fieldsPageArgs } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

/** The most open issues a fields read takes before it stops asking for pages, as the open list does. */
export const FIELDED_ISSUE_LIMIT = 5000;

/** Each field kind by the type name GitHub gives it; a kind not here is not one the push writes, so it is left out. */
const FIELD_KINDS: ReadonlyMap<string, FieldKind> = new Map([
  ['IssueFieldDate', 'date'],
  ['IssueFieldNumber', 'number'],
  ['IssueFieldSingleSelect', 'single-select'],
  ['IssueFieldText', 'text'],
]);

/**
 * GitHub's answer when its API has no issue fields or types for the query: a GraphQL field it does not know. The
 * repository then has none to write, which is no failure of the push.
 */
const NO_SUCH_FIELD = /doesn't exist on type '(Repository|Issue)'/;

/** One page of a fields read: the repository's fields and types, the open issues it held, and the next page's cursor. */
export type FieldsPage =
  | {
      readonly kind: 'page';
      readonly fields: readonly HostField[];
      readonly types: readonly string[];
      readonly issues: readonly FieldedIssue[];
      readonly unreadable: number;
      readonly items: number;
      readonly next: string | undefined;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Reads the issue fields and types of `repo` (`owner/name`) and every open issue's values of them through gh, as
 * `access` reads it: page after page until GitHub has no more or `limit` items are read. Any page failing fails the
 * whole read, so no write is planned on half of it; an API with no such fields, or a repository with none, is
 * `none`. Every failure comes back as one line, never thrown.
 */
export async function readFields(gh: GhRunner, access: RepoAccess, repo: string, limit = FIELDED_ISSUE_LIMIT): Promise<HostFieldRead> {
  const [owner, name, ...rest] = repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) {
    return { kind: 'failed', reason: `${plainLine(repo)} is not owner/name: check github.repos` };
  }
  const issues: FieldedIssue[] = [];
  let fields: readonly HostField[] = [];
  let types: readonly string[] = [];
  let unreadable = 0;
  let items = 0;
  let next: string | undefined;
  let empty = false;
  do {
    const ran = await runRead(gh, access, repo, fieldsPageArgs({ owner, name, after: next }), ISSUE_READ);
    if (ran.kind === 'failed') {
      return NO_SUCH_FIELD.test(ran.reason) ? { kind: 'none', reason: `GitHub gives ${repo} no issue fields or types to read` } : ran;
    }
    const page = parseFieldsPage(ran.stdout, repo);
    if (page.kind === 'failed') {
      return page;
    }
    if (next === undefined) {
      ({ fields, types } = page);
    }
    issues.push(...page.issues);
    unreadable += page.unreadable;
    items += page.items;
    next = page.next;
    // A page with nothing on it ends the read even when GitHub says more follow, so a bad answer cannot loop.
    empty = page.items === 0;
  } while (!empty && next !== undefined && items < limit);
  if (fields.length === 0 && types.length === 0) {
    return { kind: 'none', reason: `${repo} has no issue fields or issue types` };
  }
  const notes = [
    ...(next !== undefined && empty ? ['GitHub sent an empty page that said more follow, so the fields read may leave some issues out'] : []),
    ...(next !== undefined && !empty ? [`the fields read reached ${limit} issues, so it may leave some out`] : []),
    ...(unreadable > 0 ? [`${unreadable} item(s) gh printed did not read as issues with fields and were left out`] : []),
  ];
  return { kind: 'read', fields, types, issues, notes };
}

/**
 * One page as `gh api graphql` prints the fields query (`data.repository`). A field whose name, kind or id does not
 * read is left out, as the push cannot name it; an issue whose number, type or any value does not read is left out
 * whole and counted, so no write is planned on part of what it holds.
 */
export function parseFieldsPage(stdout: string, repo: string): FieldsPage {
  const failed: FieldsPage = { kind: 'failed', reason: `gh printed no page of the issue fields of ${repo}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed;
  }
  const data = isRecord(parsed) ? recordField(parsed, 'data') : undefined;
  const repository = data === undefined ? undefined : recordField(data, 'repository');
  const connection = repository === undefined ? undefined : recordField(repository, 'issues');
  const pageInfo = connection === undefined ? undefined : recordField(connection, 'pageInfo');
  const nodes = connection?.['nodes'];
  if (repository === undefined || pageInfo === undefined || !Array.isArray(nodes)) {
    return failed;
  }
  const more = pageInfo['hasNextPage'] === true;
  const cursor = stringField(pageInfo, 'endCursor');
  if (more && (cursor === undefined || cursor === '')) {
    return failed;
  }
  const fields = nodesOf(repository['issueFields']).flatMap((node) => {
    const field = fieldOf(node);
    return field === undefined ? [] : [field];
  });
  const types = nodesOf(repository['issueTypes']).flatMap((node) => {
    const typeName = stringField(node, 'name');
    return node['isEnabled'] === true && typeName !== undefined && typeName !== '' ? [typeName] : [];
  });
  const items: readonly unknown[] = nodes;
  const issues = items.flatMap((item) => {
    const issue = fieldedOf(item);
    return issue === undefined ? [] : [issue];
  });
  return { kind: 'page', fields, types, issues, unreadable: items.length - issues.length, items: items.length, next: more ? cursor : undefined };
}

/** One field of the repository: its name, its kind by type name, its id and, for a single-select, its options. */
function fieldOf(node: JsonRecord): HostField | undefined {
  const typeName = stringField(node, '__typename');
  const kind = typeName === undefined ? undefined : FIELD_KINDS.get(typeName);
  const name = stringField(node, 'name');
  const id = stringField(node, 'fullDatabaseId');
  if (kind === undefined || name === undefined || name === '' || id === undefined || !HOST_ID.test(id)) {
    return undefined;
  }
  const listed = node['options'];
  const optionItems: readonly unknown[] = Array.isArray(listed) ? listed : [];
  const options = optionItems.flatMap((option) => {
    const optionName = isRecord(option) ? stringField(option, 'name') : undefined;
    return optionName === undefined || optionName === '' ? [] : [optionName];
  });
  return { name, kind, id: Number(id), options };
}

/** One open issue with its type and the value of each field it has set; undefined when any part does not read. */
function fieldedOf(item: unknown): FieldedIssue | undefined {
  const number = isRecord(item) ? item['number'] : undefined;
  if (!isRecord(item) || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return undefined;
  }
  const typeField = item['issueType'];
  let type: string | undefined;
  if (typeField !== null && typeField !== undefined) {
    type = isRecord(typeField) ? stringField(typeField, 'name') : undefined;
    if (type === undefined) {
      return undefined;
    }
  }
  const values = new Map<string, FieldValue>();
  for (const node of nodesOf(item['issueFieldValues'])) {
    const entry = valueOf(node);
    if (entry === 'unreadable') {
      return undefined;
    }
    if (entry !== 'other') {
      values.set(entry.name.toLowerCase(), entry.value);
    }
  }
  return { number, type, values };
}

/** The value types the query reads; the value of a kind not here is no field the push writes, so it is passed over. */
const VALUE_TYPES: ReadonlySet<string> = new Set(['IssueFieldDateValue', 'IssueFieldNumberValue', 'IssueFieldTextValue', 'IssueFieldSingleSelectValue']);

/** One set value: its field's name and the value, a number for a number field and text for the others. */
function valueOf(node: JsonRecord): { readonly name: string; readonly value: FieldValue } | 'other' | 'unreadable' {
  const typeName = stringField(node, '__typename');
  if (typeName === undefined || !VALUE_TYPES.has(typeName)) {
    return 'other';
  }
  const field = recordField(node, 'field');
  const name = field === undefined ? undefined : stringField(field, 'name');
  const number = typeName === 'IssueFieldNumberValue';
  const value = number ? node['numberValue'] : node['value'];
  const readable = number ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'string';
  if (name === undefined || name === '' || !readable || (typeof value !== 'string' && typeof value !== 'number')) {
    return 'unreadable';
  }
  return { name, value };
}
