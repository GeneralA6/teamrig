import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampCredit, type HostIssue, type JsonRecord } from '../../../plugin-api/index.ts';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { FakeCredentials } from '../../../testing/fake-credentials.ts';
import { FakeHttp } from '../../../testing/fake-http.ts';
import { JiraClient } from './client.ts';
import { NOT_BUILT } from './declaration.ts';
import { COMMENT_PAGE, JiraTracker, MAX_PAGES, PAGE_SIZE } from './tracker.ts';

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

/** A tracker of site `acme`, its credential saved unless `saved` is false. */
function kit(stamp: boolean = false, saved: boolean = true): Kit {
  const http = new FakeHttp();
  const credentials = saved ? new FakeCredentials().saves(CREDENTIAL, 'someone@example.com:the-token') : new FakeCredentials();
  const client = new JiraClient(http, credentials, connectorDeps().scanner, () => Promise.resolve(), () => 0);
  return { tracker: new JiraTracker(client, stamp), http };
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
        jiraIssue('ENG-5', { resolution: { name: 'Done' } }),
        jiraIssue('ENG-6', { status: {} }),
        jiraIssue('ENG-7', { status: 'no status' }),
      ]),
    );
    assert.deepEqual(await tracker.list(REPO, '2026-11-10'), {
      kind: 'listed',
      issues: [
        hostIssue(2, { state: 'closed', stateReason: 'Done', closedAt: '2026-11-10T00:00:00.000Z' }),
        hostIssue(3, { state: 'closed', closedAt: '2026-11-12T10:00:00.000Z' }),
        hostIssue(4, { state: 'closed' }),
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

describe('what the Jira tracker does not do yet', () => {
  it('answers each method of a later slice with its line, and sends nothing', async () => {
    const { tracker, http } = kit();
    assert.deepEqual(await tracker.open(), failed(NOT_BUILT.open));
    assert.deepEqual(await tracker.close(), failed(NOT_BUILT.close));
    assert.deepEqual(await tracker.issueId(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.links(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.addSubIssue(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.addBlockedBy(), failed(NOT_BUILT.links));
    assert.deepEqual(await tracker.assigneeExists(), failed(NOT_BUILT.assign));
    assert.deepEqual(await tracker.assignableOn(), failed(NOT_BUILT.assign));
    assert.deepEqual(await tracker.assign(), failed(NOT_BUILT.assign));
    assert.deepEqual(await tracker.unassign(), failed(NOT_BUILT.assign));
    assert.equal('fields' in tracker, false);
    assert.deepEqual(http.requests, []);
  });
});
