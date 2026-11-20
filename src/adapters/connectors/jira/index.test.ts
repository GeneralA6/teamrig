import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectorAdapterProblems, stampCredit, type ConnectorPorts } from '../../../plugin-api/index.ts';
import { connectorDeps, portsOf } from '../../../testing/adapter-deps.ts';
import { FakeCredentials } from '../../../testing/fake-credentials.ts';
import { FakeHttp } from '../../../testing/fake-http.ts';
import { textAdf } from './adf.ts';
import { declaration } from './declaration.ts';
import adapter from './index.ts';
import { JiraTracker } from './tracker.ts';

const API = 'https://acme.atlassian.net/rest/api/3';
const REPO = 'acme/eng';
const TARGET = { repo: REPO, number: 12 };

interface Kit {
  readonly ports: ConnectorPorts;
  readonly http: FakeHttp;
}

/** The ports the adapter builds over a fake Jira API, the credential of site `acme` saved unless `saved` is false. */
function kit(stamp: boolean = true, saved: boolean = true): Kit {
  const http = new FakeHttp();
  const credentials = saved ? new FakeCredentials().saves('teamrig-jira-acme', 'someone@example.com:the-token') : new FakeCredentials();
  return { ports: portsOf(adapter, connectorDeps({ http, credentials, stamp })), http };
}

/** The tracker of `ports`; the spec fails when the adapter built none. */
function trackerOf(ports: ConnectorPorts): JiraTracker {
  const { tracker } = ports;
  if (!(tracker instanceof JiraTracker)) {
    assert.fail('the Jira adapter built no Jira tracker');
  }
  return tracker;
}

/** The body of the one request `http` was sent, read as JSON. */
function onlyBody(http: FakeHttp): unknown {
  const [request, ...more] = http.requests;
  if (request === undefined || more.length > 0 || !('body' in request) || request.body === undefined) {
    assert.fail(`expected one request with a body, got ${http.requests.length}`);
  }
  const value: unknown = JSON.parse(request.body);
  return value;
}

describe('the Jira adapter', () => {
  it('enters through defineConnector with its declaration, and builds a tracker and no code host', () => {
    assert.equal(adapter.declaration, declaration);
    assert.deepEqual(connectorAdapterProblems(adapter), []);
    const { ports } = kit();
    assert.deepEqual(Object.keys(ports), ['tracker']);
    assert.ok(ports.tracker instanceof JiraTracker);
  });

  it("reads its section of the team config: the issue type it names reaches the tracker (T4766)", async () => {
    const http = new FakeHttp();
    const credentials = new FakeCredentials().saves('teamrig-jira-acme', 'someone@example.com:the-token');
    const ports = portsOf(adapter, connectorDeps({ http, credentials, stamp: false }), { site: 'acme', projects: ['ENG'], issueType: 'Bug' });
    http.answers('GET', `${API}/issue/createmeta/ENG/issuetypes`, 200, '{"issueTypes":[{"id":"1","name":"Task"},{"id":"2","name":"Bug"}]}').answers('POST', `${API}/issue`, 201, '{"key":"ENG-3"}');
    assert.deepEqual(await trackerOf(ports).open({ repo: REPO, title: 'A title', body: '', labels: [] }), { kind: 'opened', target: { repo: REPO, number: 3 } });
    const posted = http.requests.at(-1);
    if (posted === undefined || !('body' in posted) || posted.body === undefined) {
      assert.fail('the issue was not posted');
    }
    const body: unknown = JSON.parse(posted.body);
    assert.deepEqual(body, { fields: { project: { key: 'ENG' }, summary: 'A title', issuetype: { id: '2' } } });
  });

  it('reports a key of its section it does not take, and one it cannot read, each by its name (T4766)', () => {
    const problems: string[] = [];
    adapter.configure({ site: 'acme.atlassian.net', board: 7 }, (key, problem) => problems.push(`${key} ${problem}`));
    assert.deepEqual(problems, [
      `board is no key of the ${declaration.name} connector; it takes site, projects, issueType`,
      'site must be the site\'s name, the part before .atlassian.net (acme for acme.atlassian.net), not "acme.atlassian.net"',
    ]);
  });

  it('reaches Jira through the HTTP client and the credential store it is handed', async () => {
    const signedIn = kit();
    signedIn.http.answers('GET', `${API}/myself`, 200, '{"accountId":"a1"}');
    assert.deepEqual(await trackerOf(signedIn.ports).viewer(REPO), { kind: 'found', login: 'a1' });
    assert.deepEqual(
      signedIn.http.requests.map((request) => [request.method, request.url]),
      [['GET', `${API}/myself`]],
    );

    const signedOut = kit(true, false);
    assert.equal((await trackerOf(signedOut.ports).viewer(REPO)).kind, 'failed');
    assert.deepEqual(signedOut.http.requests, []);
  });

  it("ends a comment with the made-with footer only when the team's stamp is on", async () => {
    const stamped = kit(true);
    stamped.http.answers('POST', `${API}/issue/ENG-12/comment`, 201, '{"id":"1"}');
    assert.deepEqual(await trackerOf(stamped.ports).comment(TARGET, 'Done.'), { kind: 'done' });
    assert.deepEqual(onlyBody(stamped.http), { body: textAdf('Done.', stampCredit()) });

    const plain = kit(false);
    plain.http.answers('POST', `${API}/issue/ENG-12/comment`, 201, '{"id":"1"}');
    assert.deepEqual(await trackerOf(plain.ports).comment(TARGET, 'Done.'), { kind: 'done' });
    assert.deepEqual(onlyBody(plain.http), { body: textAdf('Done.') });
    assert.notDeepEqual(textAdf('Done.', stampCredit()), textAdf('Done.'));
  });

  it('waits out a rate limit on a real timer, then asks again', async () => {
    const { ports, http } = kit();
    http.answers('GET', `${API}/myself`, 429, '', { 'retry-after': '0' }).answers('GET', `${API}/myself`, 200, '{"accountId":"a1"}');
    assert.deepEqual(await trackerOf(ports).viewer(REPO), { kind: 'found', login: 'a1' });
    assert.equal(http.requests.length, 2);
  });
});
