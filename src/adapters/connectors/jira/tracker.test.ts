import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampCredit, type HostIssue, type JsonRecord } from '../../../plugin-api/index.ts';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { FakeCredentials } from '../../../testing/fake-credentials.ts';
import { FakeHttp } from '../../../testing/fake-http.ts';
import { JiraClient } from './client.ts';
import { NOT_BUILT } from './declaration.ts';
import { COMMENT_PAGE, JiraTracker, LISTED_TYPES, MAX_PAGES, PAGE_SIZE } from './tracker.ts';

const API = 'https://acme.atlassian.net/rest/api/3';
const SEARCH = `${API}/search/jql`;
const REPO = 'acme/eng';
const TARGET = { repo: REPO, number: 12 };
const ISSUE = `${API}/issue/ENG-12`;
const CREDENTIAL = 'teamrig-jira-acme';
const NOT_A_PROJECT = '"acme" is not a Jira project: write it as <site>/<project key>, the site being the name before .atlassian.net';
const NO_ISSUE = 'Jira has no issue ENG-12 on acme (acme/eng#12), or the sign-in may not see it';
const NOT_A_LIST = "Jira's answer to the search of acme/eng did not read as a list of issues";
const LIST_FIELDS = ['summary', 'description', 'status', 'resolution', 'labels', 'assignee', 'reporter', 'updated', 'created', 'resolutiondate', 'statuscategorychangedate', 'comment'];

interface Kit {
  readonly tracker: JiraTracker;
  readonly http: FakeHttp;
}

/** A tracker of site `acme`, its credential saved unless `saved` is false; `issueType` is the type the team's config names. */
function kit(stamp: boolean = false, saved: boolean = true, issueType?: string): Kit {
  const http = new FakeHttp();
  const credentials = saved ? new FakeCredentials().saves(CREDENTIAL, 'someone@example.com:the-token') : new FakeCredentials();
  const client = new JiraClient(http, credentials, connectorDeps().scanner, () => Promise.resolve(), () => 0);
  return { tracker: new JiraTracker(client, stamp, issueType), http };
}

function parsedJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

/** Each request sent: its method, its path under the API root, and its body when it had one. */
function sent(http: FakeHttp): unknown[][] {
  return http.requests.map((request) => {
    const body = 'body' in request ? request.body : undefined;
    return [request.method, request.url.slice(API.length), ...(body === undefined ? [] : [parsedJson(body)])];
  });
}

function failed(reason: string): { kind: 'failed'; reason: string } {
  return { kind: 'failed', reason };
}

/** An issue as Jira's search gives it: open, with a title and nothing else, then `fields`. */
function jiraIssue(key: string, fields: JsonRecord = {}): JsonRecord {
  return { id: '10001', key, fields: { summary: 'A title', status: { statusCategory: { key: 'new' } }, ...fields } };
}

/** The issue `jiraIssue` reads as, then `over`. */
function hostIssue(number: number, over: Partial<HostIssue> = {}): HostIssue {
  return {
    repo: REPO,
    number,
    title: 'A title',
    body: '',
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: `https://acme.atlassian.net/browse/ENG-${number}`,
    updatedAt: undefined,
    closedAt: undefined,
    lastEditedAt: undefined,
    authorAssociation: '',
    author: '',
    authorKind: '',
    labelEvents: [],
    renamedAt: undefined,
    createdAt: undefined,
    comments: [],
    linkedPulls: 0,
    ...over,
  };
}

/** One page of a search: its issues, and the token of the next page when there is one. */
function page(issues: readonly unknown[], next?: string): string {
  return JSON.stringify({ issues, ...(next === undefined ? {} : { nextPageToken: next }) });
}

/** A document of one paragraph of one line. */
function doc(text: string): JsonRecord {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

const CLOSED = { statusCategory: { key: 'done' } };
const CREDIT = stampCredit();
/** The made-with footer as the paragraph a stamped write ends with. */
const CREDIT_PARAGRAPH = {
  type: 'paragraph',
  content: [
    { type: 'text', text: 'Made with ' },
    { type: 'text', text: CREDIT.name, marks: [{ type: 'link', attrs: { href: CREDIT.link } }] },
    { type: 'text', text: ` ${CREDIT.version}` },
  ],
};

describe('reaching a Jira project', () => {
  it('says which saved sign-in each use goes through, the site as its scope', async () => {
    const { tracker, http } = kit();
    assert.equal(tracker.name, 'Jira');
    assert.deepEqual(await tracker.reach(REPO, 'read'), { kind: 'reached', access: `acme: read with the API token saved as ${CREDENTIAL}`, scope: 'acme' });
    assert.deepEqual(await tracker.reach(REPO, 'open'), { kind: 'reached', access: `acme: opens issues with the API token saved as ${CREDENTIAL}`, scope: 'acme' });
    assert.deepEqual(await tracker.reach(REPO, 'write'), { kind: 'reached', access: `acme: writes with the API token saved as ${CREDENTIAL}`, scope: 'acme' });
    assert.deepEqual(http.requests, []);
  });

  it('is unreachable for a repo that names no project, and for a site with no saved credential', async () => {
    assert.deepEqual(await kit().tracker.reach('acme', 'read'), { kind: 'unreachable', reason: NOT_A_PROJECT });
    assert.deepEqual(await kit(false, false).tracker.reach(REPO, 'read'), {
      kind: 'unreachable',
      reason: `the test store holds no credential ${CREDENTIAL}: save the account's e-mail, a colon and its API token with save ${CREDENTIAL}`,
    });
  });
});

describe('listing a Jira project', () => {
  it('asks one search for the open issues and those closed since the day before, and reads each field', async () => {
    const { tracker, http } = kit();
    const issue = jiraIssue('ENG-12', {
      summary: 'Fix the login',
      description: doc('It fails.'),
      status: { statusCategory: { key: 'indeterminate' } },
      labels: ['bug', 'p1'],
      assignee: { accountId: 'a-assignee', accountType: 'atlassian' },
      reporter: { accountId: 'a-reporter', accountType: 'atlassian' },
      updated: '2026-11-20T15:48:00.000+0200',
      created: '2026-11-18T09:00:00.000+0200',
      comment: {
        comments: [
          { created: '2026-11-19T12:00:00.000+0200', author: { accountId: 'a-app', accountType: 'app' } },
          { created: '2026-11-19T10:00:00.000+0200', author: { accountId: 'a-customer', accountType: 'customer' } },
          { created: 'no time' },
          'not a comment',
          { created: '2026-11-19T11:00:00.000+0200', author: { accountId: 'a-other', accountType: 'something new' } },
          { created: '2026-11-19T13:00:00.000+0200' },
        ],
      },
    });
    http.answers('POST', SEARCH, 200, page([issue]));
    assert.deepEqual(await tracker.list(REPO, '2026-11-10'), {
      kind: 'listed',
      issues: [
        hostIssue(12, {
          title: 'Fix the login',
          body: 'It fails.',
          labels: ['bug', 'p1'],
          assignees: ['a-assignee'],
          updatedAt: '2026-11-20T13:48:00.000Z',
          author: 'a-reporter',
          authorKind: 'User',
          createdAt: '2026-11-18T07:00:00.000Z',
          comments: [
            { at: '2026-11-19T08:00:00.000Z', login: 'a-customer', authorAssociation: '', authorKind: 'User' },
            { at: '2026-11-19T09:00:00.000Z', login: 'a-other', authorAssociation: '', authorKind: '' },
            { at: '2026-11-19T10:00:00.000Z', login: 'a-app', authorAssociation: '', authorKind: 'Bot' },
            { at: '2026-11-19T11:00:00.000Z', login: '', authorAssociation: '', authorKind: '' },
          ],
        }),
      ],
      notes: [],
    });
    assert.deepEqual(sent(http), [
      ['POST', '/search/jql', { jql: 'project = "ENG" AND (statusCategory != Done OR statusCategoryChangedDate >= "2026-11-09")', fields: LIST_FIELDS, maxResults: PAGE_SIZE }],
    ]);
  });

  it('reads an issue as closed by its status category, and keeps the closed ones from the UTC day on', async () => {
    const { tracker, http } = kit();
    http.answers(
      'POST',
      SEARCH,
      200,
      page([
        jiraIssue('ENG-1', { status: CLOSED, statuscategorychangedate: '2026-11-10T01:59:59.000+0200' }),
        jiraIssue('ENG-2', { status: CLOSED, resolution: { name: 'Done' }, statuscategorychangedate: '2026-11-10T02:00:00.000+0200', resolutiondate: '2026-11-11T02:00:00.000+0200' }),
        jiraIssue('ENG-3', { status: CLOSED, resolutiondate: '2026-11-12T10:00:00.000+0000' }),
        jiraIssue('ENG-4', { status: CLOSED, resolution: {} }),
        jiraIssue('ENG-8', { status: CLOSED, resolution: { name: "Won't Do" } }),
        jiraIssue('ENG-9', { status: CLOSED, resolution: { name: 'Shipped' } }),
        jiraIssue('ENG-5', { resolution: { name: 'Done' } }),
        jiraIssue('ENG-6', { status: {} }),
        jiraIssue('ENG-7', { status: 'no status' }),
      ]),
    );
    assert.deepEqual(await tracker.list(REPO, '2026-11-10'), {
      kind: 'listed',
      issues: [
        hostIssue(2, { state: 'closed', stateReason: 'COMPLETED', closedAt: '2026-11-10T00:00:00.000Z' }),
        hostIssue(3, { state: 'closed', closedAt: '2026-11-12T10:00:00.000Z' }),
        hostIssue(4, { state: 'closed' }),
        hostIssue(8, { state: 'closed', stateReason: 'NOT_PLANNED' }),
        hostIssue(9, { state: 'closed', stateReason: 'Shipped' }),
        hostIssue(5),
        hostIssue(6),
        hostIssue(7),
      ],
      notes: [],
    });
  });

  it('reads every page, sending each next page its token', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, page([jiraIssue('ENG-1')], 't1')).answers('POST', SEARCH, 200, page([jiraIssue('ENG-2')], ''));
    const list = await tracker.list(REPO, '2026-11-10');
    assert.deepEqual(list, { kind: 'listed', issues: [hostIssue(1), hostIssue(2)], notes: [] });
    assert.deepEqual(
      sent(http).map(([, , body]) => (typeof body === 'object' && body !== null && 'nextPageToken' in body ? body.nextPageToken : undefined)),
      [undefined, 't1'],
    );
  });

  it('stops at its page bound and says the list may leave some out', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, page([], 'more'));
    assert.deepEqual(await tracker.list(REPO, '2026-11-10'), { kind: 'listed', issues: [], notes: [`the list reached ${MAX_PAGES * PAGE_SIZE} issues, so it may leave some out`] });
    assert.equal(http.requests.length, MAX_PAGES);
  });

  it('leaves out what does not read as an issue of the project, and says how many', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, page(['text', { key: 'OPS-3', fields: {} }, { key: 'ENG-7' }, { fields: {} }, jiraIssue('ENG-8')]));
    assert.deepEqual(await tracker.list(REPO, '2026-11-10'), {
      kind: 'listed',
      issues: [hostIssue(8)],
      notes: ['4 item(s) Jira listed did not read as issues of ENG and were left out'],
    });
  });

  it('gives nothing of a project when a page fails or is no list', async () => {
    const later = kit();
    later.http.answers('POST', SEARCH, 200, page([jiraIssue('ENG-1')], 't1')).answers('POST', SEARCH, 500);
    assert.deepEqual(await later.tracker.list(REPO, '2026-11-10'), failed('Jira answered 500'));
    for (const [status, body] of [
      [200, '{"total":0}'],
      [200, '[]'],
      [404, ''],
    ] as const) {
      const { tracker, http } = kit();
      http.answers('POST', SEARCH, status, body);
      assert.deepEqual(await tracker.list(REPO, '2026-11-10'), failed(NOT_A_LIST));
    }
  });

  it('refuses a repo that names no project and a day that is none, sending nothing', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.list('acme', '2026-11-10'), failed(NOT_A_PROJECT));
    assert.deepEqual(await tracker.list(REPO, 'yesterday'), failed('"yesterday" is not a day (YYYY-MM-DD)'));
    assert.deepEqual(await tracker.list(REPO, '2026-99-99'), failed('"2026-99-99" is not a day (YYYY-MM-DD)'));
    assert.deepEqual(http.requests, []);
  });
});

describe('watching a Jira project', () => {
  const NEWEST = page([{ id: '10042', key: 'ENG-42', fields: { updated: '2026-11-20T15:48:00.000+0200' } }]);
  const MARK = '10042@2026-11-20T15:48:00.000+0200';

  it('reads empty marks as changed, by one search of the issue changed last', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, NEWEST);
    assert.deepEqual(await tracker.watch(REPO, new Map()), { kind: 'changed', marks: new Map([['newest', MARK]]) });
    assert.deepEqual(sent(http), [['POST', '/search/jql', { jql: 'project = "ENG" ORDER BY updated DESC', fields: ['updated'], maxResults: 1 }]]);
  });

  it('is unchanged while the same issue is the newest at the same time, and changed once either moves', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, NEWEST);
    assert.deepEqual(await tracker.watch(REPO, new Map([['newest', MARK]])), { kind: 'unchanged' });
    assert.deepEqual(await tracker.watch(REPO, new Map([['newest', '10042@2026-11-20T15:00:00.000+0200']])), { kind: 'changed', marks: new Map([['newest', MARK]]) });
    assert.deepEqual(await tracker.watch(REPO, new Map([['newest', 'none']])), { kind: 'changed', marks: new Map([['newest', MARK]]) });
  });

  it('marks a project with no issue, so its first issue is a change', async () => {
    const { tracker, http } = kit();
    http.answers('POST', SEARCH, 200, page([]));
    assert.deepEqual(await tracker.watch(REPO, new Map([['newest', 'none']])), { kind: 'unchanged' });
    assert.deepEqual(await tracker.watch(REPO, new Map([['newest', MARK]])), { kind: 'changed', marks: new Map([['newest', 'none']]) });
  });

  it('fails when the look fails or names no newest issue', async () => {
    const NO_TIME = failed("Jira's answer for acme/eng names no time for the issue changed last");
    for (const newest of ['text', { fields: { updated: 'now' } }, { id: '10042' }, { id: '10042', fields: {} }]) {
      const { tracker, http } = kit();
      http.answers('POST', SEARCH, 200, page([newest]));
      assert.deepEqual(await tracker.watch(REPO, new Map()), NO_TIME);
    }
    const { tracker, http } = kit();
    http.failsOn('POST', SEARCH, 'the network is down');
    assert.deepEqual(await tracker.watch(REPO, new Map()), failed('Jira gave no answer: the network is down'));
    assert.deepEqual(await tracker.watch('acme', new Map()), failed(NOT_A_PROJECT));
  });
});

describe('writing text on a Jira issue', () => {
  it('posts a comment as plain paragraphs', async () => {
    const { tracker, http } = kit();
    http.answers('POST', `${ISSUE}/comment`, 201, '{"id":"1"}');
    assert.deepEqual(await tracker.comment(TARGET, 'First line\nsecond\n\nNext part'), { kind: 'done' });
    assert.deepEqual(sent(http), [
      [
        'POST',
        '/issue/ENG-12/comment',
        {
          body: {
            type: 'doc',
            version: 1,
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Next part' }] },
            ],
          },
        },
      ],
    ]);
  });

  it('ends a comment and a description with the made-with footer when the stamp is on', async () => {
    const { tracker, http } = kit(true);
    http.answers('POST', `${ISSUE}/comment`, 201, '{"id":"1"}').answers('PUT', ISSUE, 204);
    assert.deepEqual(await tracker.comment(TARGET, 'Done.'), { kind: 'done' });
    assert.deepEqual(await tracker.editBody(TARGET, 'The plan.'), { kind: 'done' });
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Done.' }] };
    const plan = { type: 'paragraph', content: [{ type: 'text', text: 'The plan.' }] };
    assert.deepEqual(sent(http), [
      ['POST', '/issue/ENG-12/comment', { body: { type: 'doc', version: 1, content: [paragraph, CREDIT_PARAGRAPH] } }],
      ['PUT', '/issue/ENG-12', { fields: { description: { type: 'doc', version: 1, content: [plan, CREDIT_PARAGRAPH] } } }],
    ]);
  });

  it('refuses an empty comment before any request, stamped or not', async () => {
    for (const stamp of [false, true]) {
      const { tracker, http } = kit(stamp);
      assert.deepEqual(await tracker.comment(TARGET, ' \n\n'), failed('an empty comment is not posted'));
      assert.deepEqual(http.requests, []);
    }
  });

  it('replaces a description, an empty one too', async () => {
    const { tracker, http } = kit();
    http.answers('PUT', ISSUE, 204);
    assert.deepEqual(await tracker.editBody(TARGET, 'The plan.'), { kind: 'done' });
    assert.deepEqual(await tracker.editBody(TARGET, ''), { kind: 'done' });
    assert.deepEqual(sent(http), [
      ['PUT', '/issue/ENG-12', { fields: { description: doc('The plan.') } }],
      ['PUT', '/issue/ENG-12', { fields: { description: { type: 'doc', version: 1, content: [] } } }],
    ]);
  });

  it('fails a write on an issue Jira does not show, naming it, and passes on why another write failed', async () => {
    const { tracker, http } = kit();
    http.answers('POST', `${ISSUE}/comment`, 404).answers('PUT', ISSUE, 403, '{"errorMessages":["You may not edit this issue."]}');
    assert.deepEqual(await tracker.comment(TARGET, 'Done.'), failed(NO_ISSUE));
    assert.deepEqual(await tracker.editBody(TARGET, 'The plan.'), failed('Jira answered 403: You may not edit this issue.'));
    assert.deepEqual(await tracker.comment({ repo: 'acme', number: 12 }, 'Done.'), failed(NOT_A_PROJECT));
    assert.equal(http.requests.length, 2);
  });
});

describe('reading the new comments of a Jira issue', () => {
  const COMMENTS = `${ISSUE}/comment?orderBy=-created&maxResults=${COMMENT_PAGE}`;
  const SINCE = Date.parse('2026-11-20T10:00:00.000Z');

  it('keeps those posted or edited since, oldest first, each text matched for a claim line and dropped', async () => {
    const { tracker, http } = kit();
    const person = { accountId: 'a1', accountType: 'atlassian' };
    http.answers(
      'GET',
      COMMENTS,
      200,
      JSON.stringify({
        comments: [
          { created: '2026-11-20T12:00:00.000+0000', updated: '2026-11-20T12:00:00.000+0000', author: { accountId: 'a2', accountType: 'atlassian' }, body: doc("I'll take this") },
          { created: '2026-11-20T09:00:00.000+0000', updated: '2026-11-20T11:00:00.000+0000', author: person, body: doc('Edited later') },
          { created: '2026-11-20T08:00:00.000+0000', updated: '2026-11-20T09:59:59.000+0000', author: person, body: doc('/take') },
          { created: '2026-11-20T10:00:00.000+0000', author: { accountId: 'a3', accountType: 'app' }, body: doc('/take') },
          'not a comment',
          { updated: '2026-11-20T12:00:00.000+0000', body: doc('/take') },
        ],
      }),
    );
    assert.deepEqual(await tracker.newComments(TARGET, SINCE), {
      kind: 'read',
      comments: [
        { at: '2026-11-20T09:00:00.000Z', login: 'a1', authorAssociation: '', authorKind: 'User', claims: false },
        { at: '2026-11-20T10:00:00.000Z', login: 'a3', authorAssociation: '', authorKind: 'Bot', claims: true },
        { at: '2026-11-20T12:00:00.000Z', login: 'a2', authorAssociation: '', authorKind: 'User', claims: true },
      ],
    });
    assert.deepEqual(sent(http), [['GET', `/issue/ENG-12/comment?orderBy=-created&maxResults=${COMMENT_PAGE}`]]);
  });

  it('fails when the issue is not shown, the read fails or the answer is no list of comments', async () => {
    const { tracker, http } = kit();
    http.answers('GET', COMMENTS, 404).answers('GET', COMMENTS, 500).answers('GET', COMMENTS, 200, '{"total":0}').answers('GET', COMMENTS, 200, '[]');
    const notAList = failed("Jira's answer for the comments of ENG-12 did not read as a list of comments");
    assert.deepEqual(await tracker.newComments(TARGET, SINCE), failed(NO_ISSUE));
    assert.deepEqual(await tracker.newComments(TARGET, SINCE), failed('Jira answered 500'));
    assert.deepEqual(await tracker.newComments(TARGET, SINCE), notAList);
    assert.deepEqual(await tracker.newComments(TARGET, SINCE), notAList);
    assert.deepEqual(await tracker.newComments({ repo: 'acme', number: 12 }, SINCE), failed(NOT_A_PROJECT));
  });
});

describe('labels on a Jira issue', () => {
  const SPACED = failed('"needs info" cannot be a Jira label: one holds no space');

  it('finds and makes any label Jira can hold with no request, and refuses a name it cannot', async () => {
    const { tracker, http } = kit();
    const spec = { name: 'bug', color: 'ff0000', description: 'A defect' };
    assert.deepEqual(await tracker.labelExists(REPO, 'bug'), { kind: 'found' });
    assert.deepEqual(await tracker.labelExists(REPO, 'needs info'), SPACED);
    assert.deepEqual(await tracker.labelExists(REPO, ''), failed('"" cannot be a Jira label: one holds no space'));
    assert.deepEqual(await tracker.labelExists('acme', 'bug'), failed(NOT_A_PROJECT));
    assert.deepEqual(await tracker.createLabel(REPO, spec), { kind: 'done' });
    assert.deepEqual(await tracker.createLabel(REPO, { ...spec, name: 'needs info' }), SPACED);
    assert.deepEqual(await tracker.createLabel('acme', spec), failed(NOT_A_PROJECT));
    assert.deepEqual(http.requests, []);
  });

  it("names a label by what Jira can hold, each run of white space as one hyphen, so core's status labels are found and added (T4754)", async () => {
    const { tracker, http } = kit();
    assert.equal(tracker.labelName('status:in progress'), 'status:in-progress');
    assert.equal(tracker.labelName('needs  more\tinfo'), 'needs-more-info');
    assert.equal(tracker.labelName('bug'), 'bug');
    const named = ['status:open', 'status:claimed', 'status:in progress', 'status:waiting', 'status:in review'].map((label) => tracker.labelName(label));
    for (const label of named) {
      assert.deepEqual(await tracker.labelExists(REPO, label), { kind: 'found' }, label);
    }
    http.answers('PUT', ISSUE, 204);
    assert.deepEqual(await tracker.addLabels(TARGET, named), { kind: 'done' });
    const held = ['status:open', 'status:claimed', 'status:in-progress', 'status:waiting', 'status:in-review'];
    assert.deepEqual(sent(http), [['PUT', '/issue/ENG-12', { update: { labels: held.map((add) => ({ add })) } }]]);
  });

  it('adds labels in one write, and takes one off', async () => {
    const { tracker, http } = kit();
    http.answers('PUT', ISSUE, 204);
    assert.deepEqual(await tracker.addLabels(TARGET, ['bug', 'p1']), { kind: 'done' });
    assert.deepEqual(await tracker.removeLabel(TARGET, 'bug'), { kind: 'done' });
    assert.deepEqual(sent(http), [
      ['PUT', '/issue/ENG-12', { update: { labels: [{ add: 'bug' }, { add: 'p1' }] } }],
      ['PUT', '/issue/ENG-12', { update: { labels: [{ remove: 'bug' }] } }],
    ]);
  });

  it('sends nothing for no label, refuses to add a name Jira cannot hold, and has none such to take off', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.addLabels(TARGET, []), { kind: 'done' });
    assert.deepEqual(await tracker.addLabels({ repo: 'acme', number: 12 }, []), failed(NOT_A_PROJECT));
    assert.deepEqual(await tracker.addLabels(TARGET, ['bug', 'needs info']), SPACED);
    assert.deepEqual(await tracker.removeLabel(TARGET, 'needs info'), { kind: 'done' });
    assert.deepEqual(await tracker.removeLabel({ repo: 'acme', number: 12 }, 'needs info'), failed(NOT_A_PROJECT));
    assert.deepEqual(http.requests, []);
  });

  it('reads the labels an issue carries', async () => {
    const { tracker, http } = kit();
    const LABELS = `${ISSUE}?fields=labels`;
    http
      .answers('GET', LABELS, 200, '{"key":"ENG-12","fields":{"labels":["bug","p1"]}}')
      .answers('GET', LABELS, 404)
      .answers('GET', LABELS, 500)
      .answers('GET', LABELS, 200, '{"key":"ENG-12"}')
      .answers('GET', LABELS, 200, '[]');
    const notAList = failed("Jira's answer for the labels of ENG-12 did not read as a list of labels");
    assert.deepEqual(await tracker.issueLabels(TARGET), { kind: 'read', labels: ['bug', 'p1'] });
    assert.deepEqual(await tracker.issueLabels(TARGET), { kind: 'missing' });
    assert.deepEqual(await tracker.issueLabels(TARGET), failed('Jira answered 500'));
    assert.deepEqual(await tracker.issueLabels(TARGET), notAList);
    assert.deepEqual(await tracker.issueLabels(TARGET), notAList);
    assert.deepEqual(await tracker.issueLabels({ repo: 'acme', number: 12 }), failed(NOT_A_PROJECT));
  });
});

describe('whose sign-in a Jira site has', () => {
  it('gives the account id of the sign-in', async () => {
    const { tracker, http } = kit();
    http.answers('GET', `${API}/myself`, 200, '{"accountId":"a1","accountType":"atlassian"}');
    assert.deepEqual(await tracker.viewer(REPO), { kind: 'found', login: 'a1' });
  });

  it('fails when Jira names no account, or the read fails', async () => {
    const { tracker, http } = kit();
    const MYSELF = `${API}/myself`;
    http.answers('GET', MYSELF, 200, '{}').answers('GET', MYSELF, 200, '[]').answers('GET', MYSELF, 404).answers('GET', MYSELF, 500);
    const noAccount = failed("Jira's answer on acme names no account for the sign-in");
    assert.deepEqual(await tracker.viewer(REPO), noAccount);
    assert.deepEqual(await tracker.viewer(REPO), noAccount);
    assert.deepEqual(await tracker.viewer(REPO), failed('Jira on acme does not say whose sign-in it is'));
    assert.deepEqual(await tracker.viewer(REPO), failed('Jira answered 500'));
    assert.deepEqual(await tracker.viewer('acme'), failed(NOT_A_PROJECT));
  });
});

describe('closing a Jira issue (T4754)', () => {
  const STATUS = `${ISSUE}?fields=status`;
  const OFFERED = `${ISSUE}/transitions?expand=transitions.fields`;
  const OPEN_ISSUE = JSON.stringify({ fields: { status: { statusCategory: { key: 'new' } } } });
  const DONE_STEP = { id: '31', to: { name: 'Done', ...CLOSED }, fields: { resolution: { required: true, allowedValues: [{ id: 'r1', name: 'Done' }, { id: 'r2', name: "Won't Do" }] } } };

  it('makes the transition to a closed status, with the resolution named for the reason', async () => {
    const { tracker, http } = kit();
    http.answers('GET', STATUS, 200, OPEN_ISSUE).answers('GET', OFFERED, 200, JSON.stringify({ transitions: [DONE_STEP] })).answers('POST', `${ISSUE}/transitions`, 204);
    assert.deepEqual(await tracker.close(TARGET, 'not-planned'), { kind: 'done' });
    assert.deepEqual(sent(http), [
      ['GET', '/issue/ENG-12?fields=status'],
      ['GET', '/issue/ENG-12/transitions?expand=transitions.fields'],
      ['POST', '/issue/ENG-12/transitions', { transition: { id: '31' }, fields: { resolution: { id: 'r2' } } }],
    ]);
  });

  it('closes as completed when no reason is given, and sends no resolution to a screen that takes none', async () => {
    const { tracker, http } = kit();
    const plain = { transitions: [{ id: '21', to: { name: "Won't Do", ...CLOSED } }, { id: '31', to: { name: 'Done', ...CLOSED } }] };
    http.answers('GET', STATUS, 200, OPEN_ISSUE).answers('GET', OFFERED, 200, JSON.stringify(plain)).answers('POST', `${ISSUE}/transitions`, 204);
    assert.deepEqual(await tracker.close(TARGET), { kind: 'done' });
    assert.deepEqual(sent(http)[2], ['POST', '/issue/ENG-12/transitions', { transition: { id: '31' } }]);
  });

  it('leaves an issue already closed as it is, asking for no transition', async () => {
    const { tracker, http } = kit();
    http.answers('GET', STATUS, 200, JSON.stringify({ fields: { status: CLOSED } }));
    assert.deepEqual(await tracker.close(TARGET, 'completed'), { kind: 'done' });
    assert.deepEqual(sent(http), [['GET', '/issue/ENG-12?fields=status']]);
  });

  it('fails, writing nothing, when the workflow offers no transition to a closed status', async () => {
    const { tracker, http } = kit();
    http.answers('GET', STATUS, 200, OPEN_ISSUE).answers('GET', OFFERED, 200, JSON.stringify({ transitions: [{ id: '11', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }] }));
    assert.deepEqual(await tracker.close(TARGET, 'completed'), failed("Jira offers no transition that closes ENG-12: its workflow has none from the issue's status that the sign-in may make"));
    assert.equal(http.requests.length, 2);
  });

  it('fails on an issue Jira does not show, and passes on why a read or the transition failed', async () => {
    const { tracker, http } = kit();
    http.answers('GET', STATUS, 404).answers('GET', STATUS, 200, OPEN_ISSUE);
    http.answers('GET', OFFERED, 500).answers('GET', OFFERED, 200, JSON.stringify({ transitions: [DONE_STEP] }));
    http.answers('POST', `${ISSUE}/transitions`, 400, '{"errorMessages":["The resolution is not valid."]}');
    assert.deepEqual(await tracker.close(TARGET, 'completed'), failed(NO_ISSUE));
    assert.deepEqual(await tracker.close(TARGET, 'completed'), failed('Jira answered 500'));
    assert.deepEqual(await tracker.close(TARGET, 'completed'), failed('Jira answered 400: The resolution is not valid.'));
    assert.deepEqual(await tracker.close({ repo: 'acme', number: 12 }, 'completed'), failed(NOT_A_PROJECT));
    assert.equal(http.requests.length, 6);
  });
});

describe("Jira's own id of an issue (T4754)", () => {
  const READ = `${ISSUE}?fields=summary`;

  it('reads the id as a number, and finds none for an issue Jira does not show', async () => {
    const { tracker, http } = kit();
    http.answers('GET', READ, 200, '{"id":"10042","key":"ENG-12","fields":{"summary":"A title"}}').answers('GET', READ, 404);
    assert.deepEqual(await tracker.issueId(TARGET), { kind: 'found', id: 10042 });
    assert.deepEqual(await tracker.issueId(TARGET), { kind: 'missing' });
    assert.deepEqual(sent(http), [['GET', '/issue/ENG-12?fields=summary'], ['GET', '/issue/ENG-12?fields=summary']]);
  });

  it('fails on an answer that names no id it can hold, and passes on why a read failed', async () => {
    const { tracker, http } = kit();
    const noId = failed("Jira's answer for ENG-12 names no id for the issue");
    http
      .answers('GET', READ, 200, '{"key":"ENG-12"}')
      .answers('GET', READ, 200, '{"id":10042}')
      .answers('GET', READ, 200, '{"id":"1e3"}')
      .answers('GET', READ, 200, '{"id":"1234567890123456"}')
      .answers('GET', READ, 200, '[]')
      .answers('GET', READ, 500);
    assert.deepEqual(await tracker.issueId(TARGET), noId);
    assert.deepEqual(await tracker.issueId(TARGET), noId);
    assert.deepEqual(await tracker.issueId(TARGET), noId);
    assert.deepEqual(await tracker.issueId(TARGET), noId);
    assert.deepEqual(await tracker.issueId(TARGET), noId);
    assert.deepEqual(await tracker.issueId(TARGET), failed('Jira answered 500'));
    assert.deepEqual(await tracker.issueId({ repo: 'acme', number: 12 }), failed(NOT_A_PROJECT));
    assert.equal(http.requests.length, 6);
  });
});

describe('a Jira issue as it is now (T4754)', () => {
  const READ = `${ISSUE}?fields=description,status,labels,assignee`;
  const NOT_AN_ISSUE = failed("Jira's answer for ENG-12 did not read as an issue");

  it('reads an open issue with its labels, the account holding it and its description as text', async () => {
    const { tracker, http } = kit();
    const fields = { description: doc('What is wrong.'), labels: ['bug', 'status:in-review'], assignee: { accountId: '712020:0a1b2c3d' } };
    http.answers('GET', READ, 200, JSON.stringify(jiraIssue('ENG-12', fields)));
    assert.deepEqual(await tracker.thread(TARGET), {
      kind: 'read',
      thread: { state: 'open', labels: ['bug', 'status:in-review'], assignees: ['712020:0a1b2c3d'], pull: false, body: 'What is wrong.' },
    });
    assert.deepEqual(sent(http), [['GET', '/issue/ENG-12?fields=description,status,labels,assignee']]);
  });

  it('reads a closed issue by its status, and one nobody holds with no description', async () => {
    const { tracker, http } = kit();
    http
      .answers('GET', READ, 200, JSON.stringify(jiraIssue('ENG-12', { status: CLOSED, labels: [], assignee: null, description: null })))
      .answers('GET', READ, 200, JSON.stringify(jiraIssue('ENG-12', { labels: ['bug'], assignee: { displayName: 'No id' } })));
    assert.deepEqual(await tracker.thread(TARGET), { kind: 'read', thread: { state: 'closed', labels: [], assignees: [], pull: false, body: '' } });
    assert.deepEqual(await tracker.thread(TARGET), { kind: 'read', thread: { state: 'open', labels: ['bug'], assignees: [], pull: false, body: '' } });
  });

  it('is missing for an issue Jira does not show', async () => {
    const { tracker, http } = kit();
    http.answers('GET', READ, 404);
    assert.deepEqual(await tracker.thread(TARGET), { kind: 'missing' });
  });

  it('fails on an answer with no status or no list of labels, never reading it as an open issue with no label', async () => {
    const { tracker, http } = kit();
    http
      .answers('GET', READ, 200, '{"key":"ENG-12","fields":{"labels":[]}}')
      .answers('GET', READ, 200, '{"key":"ENG-12","fields":{"status":"Done","labels":[]}}')
      .answers('GET', READ, 200, JSON.stringify(jiraIssue('ENG-12')))
      .answers('GET', READ, 200, JSON.stringify(jiraIssue('ENG-12', { labels: ['bug', 7] })))
      .answers('GET', READ, 200, '{"key":"ENG-12"}')
      .answers('GET', READ, 200, '[]');
    for (let read = 0; read < 6; read += 1) {
      assert.deepEqual(await tracker.thread(TARGET), NOT_AN_ISSUE);
    }
    assert.equal(http.requests.length, 6);
  });

  it('passes on why a read failed, and asks nothing for a repo that names no project', async () => {
    const { tracker, http } = kit();
    http.answers('GET', READ, 500);
    assert.deepEqual(await tracker.thread(TARGET), failed('Jira answered 500'));
    assert.deepEqual(await tracker.thread({ repo: 'acme', number: 12 }), failed(NOT_A_PROJECT));
    assert.equal(http.requests.length, 1);
  });
});

describe('who holds a Jira issue (T4754)', () => {
  const ACCOUNT = '712020:0a1b2c3d';
  const ASKED = 'accountId=712020%3A0a1b2c3d';
  const IN_PROJECT = `${API}/user/assignable/search?project=ENG&${ASKED}`;
  const ON_ISSUE = `${API}/user/assignable/search?issueKey=ENG-12&${ASKED}`;
  const ASSIGNEE = `${ISSUE}/assignee`;
  const HELD = `${ISSUE}?fields=assignee`;
  const NOT_ACCOUNTS = failed("Jira's answer on who may be assigned on acme did not read as a list of accounts");

  it('finds an account that may be assigned in the project, by its account id, and misses any other', async () => {
    const { tracker, http } = kit();
    http.answers('GET', IN_PROJECT, 200, JSON.stringify([{ accountId: ACCOUNT, accountType: 'atlassian' }])).answers('GET', IN_PROJECT, 200, '[]').answers('GET', IN_PROJECT, 200, '[{"accountId":"another"},7]');
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), { kind: 'found', login: ACCOUNT });
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), { kind: 'missing' });
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), { kind: 'missing' });
    assert.deepEqual(sent(http)[0], ['GET', `/user/assignable/search?project=ENG&${ASKED}`]);
  });

  it('asks nothing for an empty account id, and fails when the project does not show or the answer is no list', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.assigneeExists(REPO, ''), { kind: 'missing' });
    assert.deepEqual(await tracker.assigneeExists('acme', ACCOUNT), failed(NOT_A_PROJECT));
    assert.deepEqual(http.requests, []);
    http.answers('GET', IN_PROJECT, 404).answers('GET', IN_PROJECT, 200, '{}').answers('GET', IN_PROJECT, 500);
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), failed('Jira has no project ENG on acme, or the sign-in may not see it'));
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), NOT_ACCOUNTS);
    assert.deepEqual(await tracker.assigneeExists(REPO, ACCOUNT), failed('Jira answered 500'));
  });

  it('says whether an account may be assigned to one issue', async () => {
    const { tracker, http } = kit();
    http.answers('GET', ON_ISSUE, 200, JSON.stringify([{ accountId: ACCOUNT }])).answers('GET', ON_ISSUE, 200, '[]').answers('GET', ON_ISSUE, 404).answers('GET', ON_ISSUE, 200, '"no"');
    assert.deepEqual(await tracker.assignableOn(TARGET, ACCOUNT), { kind: 'found', login: ACCOUNT });
    assert.deepEqual(await tracker.assignableOn(TARGET, ACCOUNT), { kind: 'missing' });
    assert.deepEqual(await tracker.assignableOn(TARGET, ACCOUNT), failed(NO_ISSUE));
    assert.deepEqual(await tracker.assignableOn(TARGET, ACCOUNT), NOT_ACCOUNTS);
    assert.deepEqual(await tracker.assignableOn(TARGET, ''), { kind: 'missing' });
    assert.deepEqual(await tracker.assignableOn({ repo: 'acme', number: 12 }, ACCOUNT), failed(NOT_A_PROJECT));
    assert.equal(http.requests.length, 4);
  });

  it('gives the issue to one account, which replaces who held it', async () => {
    const { tracker, http } = kit();
    http.answers('PUT', ASSIGNEE, 204);
    assert.deepEqual(await tracker.assign(TARGET, [ACCOUNT]), { kind: 'done' });
    assert.deepEqual(await tracker.assign(TARGET, [ACCOUNT, ACCOUNT]), { kind: 'done' });
    assert.deepEqual(sent(http), [
      ['PUT', '/issue/ENG-12/assignee', { accountId: ACCOUNT }],
      ['PUT', '/issue/ENG-12/assignee', { accountId: ACCOUNT }],
    ]);
  });

  it('sends nothing for no account, and refuses a second one or an empty id', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.assign(TARGET, []), { kind: 'done' });
    assert.deepEqual(await tracker.assign({ repo: 'acme', number: 12 }, []), failed(NOT_A_PROJECT));
    assert.deepEqual(await tracker.assign(TARGET, [ACCOUNT, 'another']), failed('a Jira issue holds one assignee, so it cannot take 2 at once: name one account'));
    assert.deepEqual(await tracker.assign(TARGET, ['']), failed('an empty account id names no one to assign'));
    assert.deepEqual(http.requests, []);
  });

  it('fails an assign on an issue Jira does not show, and passes on why Jira refused one', async () => {
    const { tracker, http } = kit();
    http.answers('PUT', ASSIGNEE, 404).answers('PUT', ASSIGNEE, 400, '{"errors":{"assignee":"The user cannot be assigned issues."}}');
    assert.deepEqual(await tracker.assign(TARGET, [ACCOUNT]), failed(NO_ISSUE));
    assert.deepEqual(await tracker.assign(TARGET, [ACCOUNT]), failed('Jira answered 400: assignee: The user cannot be assigned issues.'));
    assert.deepEqual(await tracker.assign({ repo: 'acme', number: 12 }, [ACCOUNT]), failed(NOT_A_PROJECT));
  });

  it('takes an account off only when it holds the issue', async () => {
    const { tracker, http } = kit();
    http
      .answers('GET', HELD, 200, JSON.stringify({ fields: { assignee: { accountId: ACCOUNT } } }))
      .answers('GET', HELD, 200, '{"fields":{"assignee":{"accountId":"another"}}}')
      .answers('GET', HELD, 200, '{"fields":{"assignee":null}}');
    http.answers('PUT', ASSIGNEE, 204);
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), { kind: 'done' });
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), { kind: 'done' });
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), { kind: 'done' });
    assert.deepEqual(sent(http), [
      ['GET', '/issue/ENG-12?fields=assignee'],
      ['PUT', '/issue/ENG-12/assignee', { accountId: null }],
      ['GET', '/issue/ENG-12?fields=assignee'],
      ['GET', '/issue/ENG-12?fields=assignee'],
    ]);
  });

  it('takes no one off for an empty id, and fails when the issue does not show or a request fails', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.unassign(TARGET, ''), { kind: 'done' });
    assert.deepEqual(await tracker.unassign({ repo: 'acme', number: 12 }, ACCOUNT), failed(NOT_A_PROJECT));
    assert.deepEqual(http.requests, []);
    http.answers('GET', HELD, 404).answers('GET', HELD, 500).answers('GET', HELD, 200, JSON.stringify({ fields: { assignee: { accountId: ACCOUNT } } }));
    http.answers('PUT', ASSIGNEE, 403, '{"errorMessages":["You may not assign issues."]}');
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), failed(NO_ISSUE));
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), failed('Jira answered 500'));
    assert.deepEqual(await tracker.unassign(TARGET, ACCOUNT), failed('Jira answered 403: You may not assign issues.'));
  });
});

describe('opening a Jira issue (T4754)', () => {
  const TYPES = `${API}/issue/createmeta/ENG/issuetypes`;
  const CREATE = `${API}/issue`;
  const PROJECT_TYPES = JSON.stringify({ issueTypes: [{ id: '10000', name: 'Epic', subtask: false }, { id: '10002', name: 'Task', subtask: false }] });
  const OPENED = '{"id":"10042","key":"ENG-24","self":"https://acme.atlassian.net/rest/api/3/issue/10042"}';
  const DRAFT = { repo: REPO, title: 'Fix the list', body: 'First line\n\nSecond paragraph', labels: ['bug', 'status:open'] };
  const BARE = { repo: REPO, title: 'Fix the list', body: '', labels: [] };
  const BARE_FIELDS = { project: { key: 'ENG' }, summary: 'Fix the list', issuetype: { id: '10002' } };
  const NO_PROJECT = failed('Jira has no project ENG on acme, or the sign-in may not see it');

  it("opens the issue as the project's Task, its body as plain paragraphs, and names it by its number", async () => {
    const { tracker, http } = kit();
    http.answers('GET', TYPES, 200, PROJECT_TYPES).answers('POST', CREATE, 201, OPENED);
    assert.deepEqual(await tracker.open(DRAFT), { kind: 'opened', target: { repo: REPO, number: 24 } });
    const paragraphs = ['First line', 'Second paragraph'].map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
    const description = { type: 'doc', version: 1, content: paragraphs };
    assert.deepEqual(sent(http), [
      ['GET', '/issue/createmeta/ENG/issuetypes'],
      ['POST', '/issue', { fields: { ...BARE_FIELDS, labels: ['bug', 'status:open'], description } }],
    ]);
  });

  it('leaves out a description with no line and labels when there are none, and stamps one when the stamp is on', async () => {
    const plain = kit();
    plain.http.answers('GET', TYPES, 200, PROJECT_TYPES).answers('POST', CREATE, 201, OPENED);
    assert.deepEqual(await plain.tracker.open(BARE), { kind: 'opened', target: { repo: REPO, number: 24 } });
    assert.deepEqual(sent(plain.http)[1], ['POST', '/issue', { fields: BARE_FIELDS }]);
    const stamped = kit(true);
    stamped.http.answers('GET', TYPES, 200, PROJECT_TYPES).answers('POST', CREATE, 201, OPENED);
    await stamped.tracker.open(BARE);
    assert.deepEqual(sent(stamped.http)[1], ['POST', '/issue', { fields: { ...BARE_FIELDS, description: { type: 'doc', version: 1, content: [CREDIT_PARAGRAPH] } } }]);
  });

  it("asks a project's types once for all the issues one tracker opens, and again after a read that failed", async () => {
    const { tracker, http } = kit();
    http.answers('GET', TYPES, 500).answers('GET', TYPES, 200, PROJECT_TYPES);
    http.answers('POST', CREATE, 201, OPENED);
    assert.deepEqual(await tracker.open(BARE), failed('Jira answered 500'));
    await tracker.open(BARE);
    await tracker.open(BARE);
    assert.deepEqual(sent(http).map(([method]) => method), ['GET', 'GET', 'POST', 'POST']);
  });

  it('refuses, asking nothing, a place that is no project, a blank title and a label Jira cannot hold', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.open({ ...BARE, repo: 'acme' }), failed(NOT_A_PROJECT));
    assert.deepEqual(await tracker.open({ ...BARE, title: ' \t' }), failed('an issue with no title is not opened'));
    assert.deepEqual(await tracker.open({ ...BARE, labels: ['bug', 'needs info'] }), failed('"needs info" cannot be a Jira label: one holds no space'));
    assert.deepEqual(http.requests, []);
  });

  it('opens nothing when the project does not show or names no type an issue can open as', async () => {
    const { tracker, http } = kit();
    http.answers('GET', TYPES, 404).answers('GET', TYPES, 200, '{"issueTypes":[{"id":"10003","name":"Sub-task","subtask":true}]}');
    assert.deepEqual(await tracker.open(BARE), NO_PROJECT);
    assert.deepEqual(await tracker.open(BARE), failed('Jira names no issue type the sign-in may open an issue of ENG as'));
    assert.equal(http.requests.length, 2);
  });

  it("opens the issue as the type the team's config names, and opens none when the project lacks it, naming those it has (T4766)", async () => {
    const named = kit(false, true, 'epic');
    named.http.answers('GET', TYPES, 200, PROJECT_TYPES).answers('POST', CREATE, 201, OPENED);
    assert.deepEqual(await named.tracker.open(BARE), { kind: 'opened', target: { repo: REPO, number: 24 } });
    assert.deepEqual(sent(named.http), [
      ['GET', '/issue/createmeta/ENG/issuetypes'],
      ['POST', '/issue', { fields: { ...BARE_FIELDS, issuetype: { id: '10000' } } }],
    ]);

    const lacking = kit(false, true, 'Bug');
    lacking.http.answers('GET', TYPES, 200, PROJECT_TYPES).answers('GET', TYPES, 200, '{"issueTypes":[]}');
    assert.deepEqual(
      await lacking.tracker.open(BARE),
      failed('ENG has no issue type "Bug" the sign-in may open an issue as (it has Epic, Task): name one of them in connectors.jira.issueType'),
    );
    assert.deepEqual(
      await lacking.tracker.open(BARE),
      failed('ENG has no issue type "Bug" the sign-in may open an issue as (it has none): name one of them in connectors.jira.issueType'),
    );
    assert.equal(lacking.http.requests.length, 2);
  });

  it("makes Jira's type names plain lines and lists at most LISTED_TYPES of them when the named type is missing", async () => {
    const lacking = kit(false, true, 'Bug');
    const many = Array.from({ length: LISTED_TYPES + 3 }, (_, at) => ({ id: `${20000 + at}`, name: at === 0 ? 'Ta\nsk\u0007' : `T${at}` }));
    lacking.http.answers('GET', TYPES, 200, JSON.stringify({ issueTypes: many }));
    const listed = ['Ta sk', ...Array.from({ length: LISTED_TYPES - 1 }, (_, at) => `T${at + 1}`)].join(', ');
    assert.deepEqual(
      await lacking.tracker.open(BARE),
      failed(`ENG has no issue type "Bug" the sign-in may open an issue as (it has ${listed} and 3 more): name one of them in connectors.jira.issueType`),
    );
  });

  it('passes on why Jira opened none, and fails on an answer that names no issue of the project', async () => {
    const { tracker, http } = kit();
    http.answers('GET', TYPES, 200, PROJECT_TYPES);
    http
      .answers('POST', CREATE, 400, '{"errorMessages":[],"errors":{"summary":"Summary must be less than 255 characters."}}')
      .answers('POST', CREATE, 404)
      .answers('POST', CREATE, 201, '{"id":"10042","key":"OPS-3"}')
      .answers('POST', CREATE, 201);
    const unnamed = failed('Jira opened an issue of acme/eng and its answer names no issue of ENG: find it on the site before opening another');
    assert.deepEqual(await tracker.open(BARE), failed('Jira answered 400: summary: Summary must be less than 255 characters.'));
    assert.deepEqual(await tracker.open(BARE), NO_PROJECT);
    assert.deepEqual(await tracker.open(BARE), unnamed);
    assert.deepEqual(await tracker.open(BARE), unnamed);
  });
});

describe('what the Jira tracker does not do yet', () => {
  it('answers each method of a later slice with its line, and sends nothing', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.links(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.addSubIssue(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.addBlockedBy(), failed(NOT_BUILT.links));
    assert.equal('fields' in tracker, false);
    assert.deepEqual(http.requests, []);
  });
});
