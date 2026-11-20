import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectorDeps } from '../../../testing/adapter-deps.ts';
import { FakeCredentials } from '../../../testing/fake-credentials.ts';
import { FakeHttp } from '../../../testing/fake-http.ts';
import { JiraClient, RATE_LIMIT_JITTER_MS, RATE_LIMIT_MAX_WAIT_MS, RATE_LIMIT_RETRIES, type JiraAnswer } from './client.ts';

const API = 'https://acme.atlassian.net/rest/api/3';
const CREDENTIAL = 'teamrig-jira-acme';
/** The saved pair, and the header it signs in with: `Basic` and the pair in base64. */
const PAIR = 'someone@example.com:the-token';
const HEADER = 'Basic c29tZW9uZUBleGFtcGxlLmNvbTp0aGUtdG9rZW4=';
const SIGNED = { authorization: HEADER, accept: 'application/json' };
const SAVE_LINE = `save the account's e-mail, a colon and its API token with save ${CREDENTIAL}`;

/** A text the scanner knows as a secret, joined here so this file holds none. */
function join(...parts: readonly string[]): string {
  return parts.join('');
}

interface Kit {
  readonly client: JiraClient;
  readonly http: FakeHttp;
  readonly credentials: FakeCredentials;
  /** Each wait the client asked for, in milliseconds. */
  readonly waits: number[];
}

/** A client of site `acme` whose credential is saved, with waits recorded instead of slept; `jitter` as Math.random would give it. */
function kit(jitter: number = 0): Kit {
  const http = new FakeHttp();
  const credentials = new FakeCredentials().saves(CREDENTIAL, PAIR);
  const waits: number[] = [];
  const wait = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { client: new JiraClient(http, credentials, connectorDeps().scanner, wait, () => jitter), http, credentials, waits };
}

/** What a GET of `/thing` comes to when Jira answers it with `status` and `body`. */
async function answerTo(status: number, body: string = ''): Promise<JiraAnswer> {
  const { client, http } = kit();
  http.answers('GET', `${API}/thing`, status, body);
  return await client.get('acme', '/thing');
}

function failed(reason: string): JiraAnswer {
  return { kind: 'failed', reason };
}

describe('signing in to a Jira site', () => {
  it('sends the saved pair as a basic header, in base64', async () => {
    const { client, http, credentials } = kit();
    http.answers('GET', `${API}/myself`, 200, '{"accountId":"a1"}');
    assert.deepEqual(await client.signIn('acme'), { kind: 'found', header: HEADER });
    assert.deepEqual(await client.get('acme', '/myself'), { kind: 'ok', body: { accountId: 'a1' } });
    assert.deepEqual(http.requests, [{ method: 'GET', url: `${API}/myself`, headers: SIGNED }]);
    assert.deepEqual(credentials.reads, [CREDENTIAL]);
  });

  it('reads a site\'s credential once for all its requests, and each site\'s own', async () => {
    const { client, http, credentials } = kit();
    credentials.saves('teamrig-jira-globex', PAIR);
    http.answers('GET', `${API}/a`, 200, '{}').answers('GET', `${API}/b`, 200, '{}').answers('GET', 'https://globex.atlassian.net/rest/api/3/a', 200, '{}');
    await Promise.all([client.get('acme', '/a'), client.get('acme', '/b')]);
    await client.get('globex', '/a');
    await client.get('acme', '/a');
    assert.deepEqual(credentials.reads, [CREDENTIAL, 'teamrig-jira-globex']);
  });

  it('says how to save the credential when the store holds none, and sends nothing', async () => {
    const http = new FakeHttp();
    const client = new JiraClient(http, new FakeCredentials(), connectorDeps().scanner, () => Promise.resolve(), () => 0);
    const reason = `the test store holds no credential ${CREDENTIAL}: ${SAVE_LINE}`;
    assert.deepEqual(await client.signIn('acme'), failed(reason));
    assert.deepEqual(await client.get('acme', '/myself'), failed(reason));
    assert.deepEqual(await client.post('acme', '/search/jql', {}), failed(reason));
    assert.deepEqual(http.requests, []);
  });

  it('says why a credential could not be read', async () => {
    const { client, http, credentials } = kit();
    credentials.failsOn(CREDENTIAL, 'the keyring is locked');
    assert.deepEqual(await client.get('acme', '/myself'), failed(`credential ${CREDENTIAL} could not be read from the test store: the keyring is locked`));
    assert.deepEqual(http.requests, []);
  });

  it('refuses a credential that is not an e-mail, a colon and a token, without quoting it', async () => {
    for (const secret of ['the-token', ':the-token', 'someone@example.com:']) {
      const { client, http, credentials } = kit();
      credentials.saves(CREDENTIAL, secret);
      assert.deepEqual(await client.get('acme', '/myself'), failed(`credential ${CREDENTIAL} is not an e-mail, a colon and an API token: ${SAVE_LINE}`), secret);
      assert.deepEqual(http.requests, [], secret);
    }
  });
});

describe('a Jira answer', () => {
  it('is its JSON when Jira sent some', async () => {
    assert.deepEqual(await answerTo(200, '{"issues":[],"total":0}'), { kind: 'ok', body: { issues: [], total: 0 } });
    assert.deepEqual(await answerTo(201, '[1,"two"]'), { kind: 'ok', body: [1, 'two'] });
  });

  it('is ok with no body when Jira sent none', async () => {
    assert.deepEqual(await answerTo(204), { kind: 'ok', body: undefined });
    assert.deepEqual(await answerTo(200, ' \n'), { kind: 'ok', body: undefined });
  });

  it('fails on a success whose text is not JSON', async () => {
    assert.deepEqual(await answerTo(200, '<html>maintenance</html>'), failed('Jira answered 200 with text that is not JSON'));
  });

  it('is missing on a 404', async () => {
    assert.deepEqual(await answerTo(404, '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}'), { kind: 'missing' });
  });

  it('names the credential and how to save it on a refused sign-in', async () => {
    assert.deepEqual(await answerTo(401, 'Client must be authenticated'), failed(`Jira refused the sign-in (401): the API token saved as ${CREDENTIAL} may have expired; ${SAVE_LINE}`));
  });

  it('follows no redirect', async () => {
    assert.deepEqual(await answerTo(302), failed('Jira answered 302, a redirect, which teamrig does not follow'));
  });

  it('quotes the first thing Jira said was wrong: a message, else a field with its message', async () => {
    assert.deepEqual(await answerTo(400, '{"errorMessages":["The JQL is not valid.","Second"],"errors":{"jql":"bad"}}'), failed('Jira answered 400: The JQL is not valid.'));
    assert.deepEqual(await answerTo(400, '{"errorMessages":[],"errors":{"labels":"The label holds a space.","summary":"needed"}}'), failed('Jira answered 400: labels: The label holds a space.'));
    assert.deepEqual(await answerTo(403, '{"errors":{"description":"no permission"}}'), failed('Jira answered 403: description: no permission'));
  });

  it('gives the status alone when the body says nothing it can read', async () => {
    for (const body of ['', '{}', '{"errorMessages":[],"errors":{}}', '{"errorMessages":"one text","errors":{"labels":{"nested":true}}}', '["The JQL is not valid."]', '<html>Bad gateway</html>']) {
      assert.deepEqual(await answerTo(502, body), failed('Jira answered 502'), body);
    }
  });

  it('quotes Jira\'s words as one line, cut short', async () => {
    assert.deepEqual(await answerTo(400, JSON.stringify({ errorMessages: ['  first line\r\nsecond\tline\u0007\u0085end  '] })), failed('Jira answered 400: first line second line end'));
    assert.deepEqual(await answerTo(400, JSON.stringify({ errorMessages: ['x'.repeat(201)] })), failed(`Jira answered 400: ${'x'.repeat(200)}...`));
    assert.deepEqual(await answerTo(400, JSON.stringify({ errorMessages: ['x'.repeat(200)] })), failed(`Jira answered 400: ${'x'.repeat(200)}`));
  });

  it('redacts a secret shape in Jira\'s words, one the cut runs through too', async () => {
    const assignment = join('password', '=', 'hunter2');
    assert.deepEqual(await answerTo(400, JSON.stringify({ errors: { summary: `holds ${assignment} here` } })), failed('Jira answered 400: summary: holds [redacted password or key assignment] here'));
    const token = join('gh', 'p_', 'A'.repeat(36));
    assert.deepEqual(await answerTo(400, JSON.stringify({ errorMessages: [`${'x'.repeat(180)} ${token}`] })), failed(`Jira answered 400: ${'x'.repeat(180)} [redacted GitHub to...`));
  });

  it('says so when no answer came, in the port\'s own words', async () => {
    const { client, http } = kit();
    http.failsOn('GET', `${API}/thing`, 'the server could not be reached (ECONNREFUSED)');
    assert.deepEqual(await client.get('acme', '/thing'), failed('Jira gave no answer: the server could not be reached (ECONNREFUSED)'));
    assert.equal(http.requests.length, 1);
  });
});

describe('a request with a body', () => {
  it('goes as JSON by POST and by PUT, and a GET carries none', async () => {
    const { client, http } = kit();
    http.answers('POST', `${API}/search/jql`, 200, '{"issues":[]}').answers('PUT', `${API}/issue/ENG-12`, 204).answers('GET', `${API}/issue/ENG-12`, 200, '{}');
    assert.deepEqual(await client.post('acme', '/search/jql', { jql: 'project = "ENG"', maxResults: 100 }), { kind: 'ok', body: { issues: [] } });
    assert.deepEqual(await client.put('acme', '/issue/ENG-12', { fields: { labels: ['a'] } }), { kind: 'ok', body: undefined });
    await client.get('acme', '/issue/ENG-12');
    const json = { ...SIGNED, 'content-type': 'application/json' };
    assert.deepEqual(http.requests, [
      { method: 'POST', url: `${API}/search/jql`, headers: json, body: '{"jql":"project = \\"ENG\\"","maxResults":100}' },
      { method: 'PUT', url: `${API}/issue/ENG-12`, headers: json, body: '{"fields":{"labels":["a"]}}' },
      { method: 'GET', url: `${API}/issue/ENG-12`, headers: SIGNED },
    ]);
  });
});

describe('a request Jira turns away for its rate limit', () => {
  it('is sent again after the wait Jira names', async () => {
    const { client, http, waits } = kit();
    http.answers('POST', `${API}/search/jql`, 429, '', { 'retry-after': '3' }).answers('POST', `${API}/search/jql`, 200, '{"issues":[]}');
    assert.deepEqual(await client.post('acme', '/search/jql', { jql: 'x' }), { kind: 'ok', body: { issues: [] } });
    assert.deepEqual(waits, [3000]);
    assert.equal(http.requests.length, 2);
    assert.deepEqual(http.requests[1], http.requests[0]);
  });

  it('waits a second when Jira names no wait or one that is no count of seconds, stretched by chance', async () => {
    assert.equal(RATE_LIMIT_JITTER_MS, 250);
    for (const headers of [{}, { 'retry-after': 'Fri, 20 Nov 2026 12:00:00 GMT' }, { 'retry-after': '-5' }]) {
      const { client, http, waits } = kit(0.5);
      http.answers('GET', `${API}/thing`, 429, '', headers).answers('GET', `${API}/thing`, 200, '{}');
      assert.deepEqual(await client.get('acme', '/thing'), { kind: 'ok', body: {} });
      assert.deepEqual(waits, [1125]);
    }
  });

  it('gives up after two more tries, saying to run it again later', async () => {
    assert.equal(RATE_LIMIT_RETRIES, 2);
    const { client, http, waits } = kit();
    http.answers('GET', `${API}/thing`, 429);
    assert.deepEqual(await client.get('acme', '/thing'), failed('Jira is limiting requests (429) and asks to wait 1 s more: run it again later'));
    assert.deepEqual(waits, [1000, 1000]);
    assert.equal(http.requests.length, 3);
  });

  it('waits no longer than a minute in all: a longer wait is refused before it starts', async () => {
    assert.equal(RATE_LIMIT_MAX_WAIT_MS, 60_000);
    const long = kit();
    long.http.answers('GET', `${API}/thing`, 429, '', { 'retry-after': '61' });
    assert.deepEqual(await long.client.get('acme', '/thing'), failed('Jira is limiting requests (429) and asks to wait 61 s more: run it again later'));
    assert.deepEqual(long.waits, []);
    assert.equal(long.http.requests.length, 1);

    const whole = kit();
    whole.http.answers('GET', `${API}/thing`, 429, '', { 'retry-after': '60' }).answers('GET', `${API}/thing`, 200, '{}');
    assert.deepEqual(await whole.client.get('acme', '/thing'), { kind: 'ok', body: {} });
    assert.deepEqual(whole.waits, [60_000]);

    const summed = kit(0.5);
    summed.http.answers('GET', `${API}/thing`, 429, '', { 'retry-after': '40' });
    assert.deepEqual(await summed.client.get('acme', '/thing'), failed('Jira is limiting requests (429) and asks to wait 41 s more: run it again later'));
    assert.deepEqual(summed.waits, [40_125]);
    assert.equal(summed.http.requests.length, 2);
  });

  it('sends nothing else twice: a failure after a wait ends the request', async () => {
    const { client, http, waits } = kit();
    http.answers('GET', `${API}/thing`, 429).answers('GET', `${API}/thing`, 500, '{"errorMessages":["Internal error"]}');
    assert.deepEqual(await client.get('acme', '/thing'), failed('Jira answered 500: Internal error'));
    assert.deepEqual(waits, [1000]);
    assert.equal(http.requests.length, 2);
  });
});
