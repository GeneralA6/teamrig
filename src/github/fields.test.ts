import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGh } from '../testing/fake-gh.ts';
import { parseFieldsPage, readFields } from './fields.ts';
import { isIssueQuery, type GhRequest, type GhResult, type GhRunner } from './gh.ts';
import { ISSUE_FIELDS_QUERY } from './queries.ts';
import type { RepoAccess } from './tokens.ts';

const REPO = 'acme/web';
const ACCESS: RepoAccess = { owner: 'acme', credential: 'teamrig-gh-acme', save: 'save teamrig-gh-acme', env: { HOME: '/u', GH_TOKEN: 'read-token' } };

const FIELDS = [
  { __typename: 'IssueFieldSingleSelect', name: 'Priority', fullDatabaseId: '11', options: [{ name: 'P0' }, { name: 'P1' }, { name: '' }] },
  { __typename: 'IssueFieldDate', name: 'Start date', fullDatabaseId: '12' },
  { __typename: 'IssueFieldNumber', name: 'Score', fullDatabaseId: '14' },
  { __typename: 'IssueFieldText', name: 'Notes', fullDatabaseId: '15' },
];
const TYPES = [
  { name: 'Task', isEnabled: true },
  { name: 'Bug', isEnabled: true },
  { name: 'Old', isEnabled: false },
];

function date(name: string, value: string): Readonly<Record<string, unknown>> {
  return { __typename: 'IssueFieldDateValue', field: { name }, value };
}

function issueNode(number: number, type: string | null, values: readonly unknown[] = []): Readonly<Record<string, unknown>> {
  return { number, issueType: type === null ? null : { name: type }, issueFieldValues: { nodes: values } };
}

function page(nodes: readonly unknown[], next?: string, repository: Readonly<Record<string, unknown>> = {}): string {
  const issues = { pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes };
  return JSON.stringify({ data: { repository: { issueTypes: { nodes: TYPES }, issueFields: { nodes: FIELDS }, issues, ...repository } } });
}

function exited(stdout: string, code = 0, stderr = ''): GhResult {
  return { end: { kind: 'exited', code }, stdout, stderr };
}

/** A gh that answers each run with the next of `answers`, and records what it was asked. */
class InTurnGh implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly answers: GhResult[];

  constructor(answers: readonly GhResult[]) {
    this.answers = [...answers];
  }

  run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    return Promise.resolve(this.answers.shift() ?? exited('', 1, 'no answer left'));
  }
}

describe('parseFieldsPage (T3406)', () => {
  it("reads the repository's fields by kind, its turned-on types, and each open issue's type and values", () => {
    const nodes = [
      issueNode(7, 'Task', [
        date('Start date', '2030-01-08'),
        { __typename: 'IssueFieldNumberValue', field: { name: 'Score' }, numberValue: 18 },
        { __typename: 'IssueFieldSingleSelectValue', field: { name: 'Priority' }, value: 'P1' },
        { __typename: 'IssueFieldSomethingNew', field: { name: 'Later' } },
      ]),
      issueNode(8, null),
    ];
    const read = parseFieldsPage(page(nodes, 'Y3Vyc29y'), REPO);
    assert.deepEqual(read, {
      kind: 'page',
      fields: [
        { name: 'Priority', kind: 'single-select', id: 11, options: ['P0', 'P1'] },
        { name: 'Start date', kind: 'date', id: 12, options: [] },
        { name: 'Score', kind: 'number', id: 14, options: [] },
        { name: 'Notes', kind: 'text', id: 15, options: [] },
      ],
      types: ['Task', 'Bug'],
      issues: [
        { number: 7, type: 'Task', values: new Map<string, string | number>([['start date', '2030-01-08'], ['score', 18], ['priority', 'P1']]) },
        { number: 8, type: undefined, values: new Map() },
      ],
      unreadable: 0,
      items: 2,
      next: 'Y3Vyc29y',
    });
  });

  it('leaves out a field it cannot name, and leaves out and counts an issue whose number, type or any value does not read', () => {
    const fields = [{ __typename: 'IssueFieldIteration', name: 'Sprint', fullDatabaseId: '16' }, { __typename: 'IssueFieldDate', name: 'Due', fullDatabaseId: '0' }, { __typename: 'IssueFieldDate', fullDatabaseId: '17' }];
    const nodes = [
      'not an issue',
      issueNode(0, 'Task'),
      { ...issueNode(7, 'Task'), issueType: { name: 3 } },
      issueNode(7, 'Task', [{ __typename: 'IssueFieldDateValue', value: '2030-01-08' }]),
      issueNode(7, 'Task', [{ __typename: 'IssueFieldNumberValue', field: { name: 'Score' }, numberValue: '18' }]),
      issueNode(7, 'Task', [{ __typename: 'IssueFieldTextValue', field: { name: 'Notes' }, value: null }]),
      issueNode(7, 'Task'),
    ];
    const read = parseFieldsPage(page(nodes, undefined, { issueFields: { nodes: fields } }), REPO);
    assert.deepEqual(read.kind === 'page' && [read.fields, read.issues.map((issue) => issue.number), read.unreadable, read.items], [[], [7], 6, 7]);
  });

  it('fails on anything that is not a page, or a page that says more follow with no cursor', () => {
    const failed = { kind: 'failed', reason: 'gh printed no page of the issue fields of acme/web' };
    for (const stdout of ['', 'not json', '[]', '{"data":{"repository":null}}', JSON.stringify({ data: { repository: { issues: { pageInfo: {}, nodes: {} } } } })]) {
      assert.deepEqual(parseFieldsPage(stdout, REPO), failed, stdout);
    }
    assert.deepEqual(parseFieldsPage(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: '' }, nodes: [] } } } }), REPO), failed);
  });
});

describe('readFields (T3406)', () => {
  it('reads every page of the shipped fields query, the fields and types from the first', async () => {
    const gh = new InTurnGh([exited(page([issueNode(1, 'Task')], 'Y3Vyc29y')), exited(page([issueNode(2, null)], undefined, { issueFields: { nodes: [] } }))]);
    const read = await readFields(gh, ACCESS, REPO);
    assert.ok(read.kind === 'read');
    assert.deepEqual([read.fields.length, read.types, read.issues.map((issue) => issue.number), read.notes], [4, ['Task', 'Bug'], [1, 2], []]);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args) && request.args.includes(`query=${ISSUE_FIELDS_QUERY}`)));
    assert.deepEqual(gh.ran[1]?.args.slice(-2), ['-f', 'after=Y3Vyc29y']);
    assert.equal(gh.ran[0]?.env, ACCESS.env);
  });

  it('says when it stopped at its limit, or left out items it could not read', async () => {
    const gh = new InTurnGh([exited(page([issueNode(1, 'Task'), 'junk'], 'Y3Vyc29y'))]);
    const read = await readFields(gh, ACCESS, REPO, 2);
    assert.deepEqual(read.kind === 'read' && read.notes, ['the fields read reached 2 issues, so it may leave some out', '1 item(s) gh printed did not read as issues with fields and were left out']);
    const empty = await readFields(new InTurnGh([exited(page([], 'Y3Vyc29y'))]), ACCESS, REPO);
    assert.deepEqual(empty.kind === 'read' && empty.notes, ['GitHub sent an empty page that said more follow, so the fields read may leave some issues out']);
  });

  it('is none for a repository with no fields or types, and for an API that has no such fields', async () => {
    const bare = new InTurnGh([exited(page([issueNode(1, null)], undefined, { issueFields: { nodes: [] }, issueTypes: { nodes: [] } }))]);
    assert.deepEqual(await readFields(bare, ACCESS, REPO), { kind: 'none', reason: 'acme/web has no issue fields or issue types' });
    const old = new InTurnGh([exited('', 1, "GraphQL: Field 'issueFields' doesn't exist on type 'Repository' (repository.issueFields)")]);
    assert.deepEqual(await readFields(old, ACCESS, REPO), { kind: 'none', reason: 'GitHub gives acme/web no issue fields or types to read' });
  });

  it('fails whole when any page fails, for a repository that is not owner/name, or a gh that cannot start', async () => {
    const second = new InTurnGh([exited(page([issueNode(1, 'Task')], 'Y3Vyc29y')), exited('not json')]);
    assert.deepEqual(await readFields(second, ACCESS, REPO), { kind: 'failed', reason: 'gh printed no page of the issue fields of acme/web' });
    assert.deepEqual(await readFields(new FakeGh(), ACCESS, 'acme/nope'), {
      kind: 'failed',
      reason: 'acme/nope is not visible to the token saved as teamrig-gh-acme: check github.repos, and on GitHub give that token this repository',
    });
    const gh = new InTurnGh([]);
    assert.deepEqual(await readFields(gh, ACCESS, 'acme'), { kind: 'failed', reason: 'acme is not owner/name: check github.repos' });
    assert.deepEqual(gh.ran, []);
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const failed = await readFields(absent, ACCESS, REPO);
    assert.ok(failed.kind === 'failed' && failed.reason.startsWith('gh, the GitHub CLI, is not installed'));
  });
});
