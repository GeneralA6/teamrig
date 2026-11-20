import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../lib/guards.ts';
import {
  ACTIONS_APP_ID,
  appJwt,
  checksRefusal,
  codeSpan,
  fetchGitHubApi,
  mergeComment,
  mergeRelease,
  releaseGate,
  requiredChecksOf,
  type ApiRequest,
  type CheckRun,
  type Fetch,
  type GateTarget,
  type GitHubApi,
  type MergeTarget,
} from './release-merge.ts';

const REPO = 'acme/tool';
const SHA = 'a'.repeat(40);
const TARGET: GateTarget = { repo: REPO, runId: 7, main: 'main', head: 'release-please--branches--main', summary: 'every check passed' };

/** A fake GitHub: answers by `METHOD path` (query included), a function or an Error to reject, and records each call. */
class FakeGitHub {
  readonly calls: ApiRequest[] = [];
  private readonly routes = new Map<string, unknown>();

  on(method: string, path: string, answer: unknown): this {
    this.routes.set(`${method} ${path}`, answer);
    return this;
  }

  readonly api: GitHubApi = async (request) => {
    this.calls.push(request);
    const key = `${request.method} ${request.path}`;
    if (!this.routes.has(key)) throw new Error(`no fake answer for ${key}`);
    const answer = this.routes.get(key);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const run = (over: JsonRecord = {}): JsonRecord => ({
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: SHA,
  head_branch: TARGET.head,
  head_repository: { full_name: REPO },
  ...over,
});

const pull = (over: JsonRecord = {}): JsonRecord => ({
  number: 12,
  state: 'open',
  draft: false,
  commits: 1,
  user: { login: 'github-actions[bot]' },
  base: { ref: 'main', repo: { full_name: REPO } },
  head: { ref: TARGET.head, sha: SHA, repo: { full_name: REPO } },
  ...over,
});

const checkRun = (name: string, conclusion: string | null = 'success', over: JsonRecord = {}): JsonRecord => ({
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  app: { id: ACTIONS_APP_ID },
  ...over,
});

const rules = (...contexts: readonly JsonRecord[]): readonly JsonRecord[] => [
  { type: 'pull_request', parameters: {} },
  { type: 'required_status_checks', parameters: { required_status_checks: contexts } },
];

const PULLS = `/repos/${REPO}/pulls?state=open&base=main&head=${encodeURIComponent(`acme:${TARGET.head}`)}&per_page=100`;
const checksPath = (page: number): string => `/repos/${REPO}/commits/${SHA}/check-runs?filter=latest&per_page=100&page=${page}`;

/** A GitHub where everything passes; each test changes the one answer it is about. */
function passing(): FakeGitHub {
  const runs = [checkRun('lint'), checkRun('test'), checkRun('every check passed'), checkRun('docs', 'skipped')];
  return new FakeGitHub()
    .on('GET', `/repos/${REPO}/actions/runs/7`, run())
    .on('GET', PULLS, [{ number: 12 }])
    .on('GET', `/repos/${REPO}/pulls/12`, pull())
    .on('GET', `/repos/${REPO}/rules/branches/main?per_page=100`, rules({ context: 'every check passed', integration_id: ACTIONS_APP_ID }))
    .on('GET', checksPath(1), { total_count: runs.length, check_runs: runs })
    .on('GET', `/repos/${REPO}/commits/${SHA}/status`, { state: 'pending', total_count: 0 });
}

const gateOf = (github: FakeGitHub, filesRefusal: (sha: string) => string | null = () => null) => releaseGate(TARGET, { api: github.api, token: 'read-token', filesRefusal });

async function refusal(github: FakeGitHub, filesRefusal?: (sha: string) => string | null): Promise<string> {
  const outcome = await gateOf(github, filesRefusal);
  assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
  return 'reason' in outcome ? outcome.reason : '';
}

describe('releaseGate', () => {
  it('passes the one release pull request at the head ci passed, counting its successful checks', async () => {
    const github = passing();
    const filesAsked: string[] = [];
    const outcome = await gateOf(github, (sha) => {
      filesAsked.push(sha);
      return null;
    });
    assert.deepEqual(outcome, { kind: 'pass', pr: 12, sha: SHA, checks: 3 });
    assert.deepEqual(filesAsked, [SHA]);
    assert.ok(github.calls.every((call) => call.method === 'GET' && call.token === 'read-token'));
  });

  for (const [what, over, expected] of [
    ['another event', { event: 'pull_request' }, /started by `pull_request`/],
    ['a failed run', { conclusion: 'failure' }, /did not pass/],
    ['a run still going', { status: 'in_progress', conclusion: null }, /did not pass/],
    ['a fork', { head_repository: { full_name: 'evil/tool' } }, /another repository/],
    ['another branch', { head_branch: 'feature' }, /not on the release branch/],
    ['a short sha', { head_sha: 'abc' }, /no full commit sha/],
  ] as const) {
    it(`refuses a ci run from ${what}`, async () => {
      assert.match(await refusal(passing().on('GET', `/repos/${REPO}/actions/runs/7`, run(over))), expected);
    });
  }

  it('is stale when no release pull request is open', async () => {
    assert.deepEqual(await gateOf(passing().on('GET', PULLS, [])), { kind: 'stale', reason: 'no release pull request is open' });
  });

  it('refuses two open pull requests from the release branch', async () => {
    assert.match(await refusal(passing().on('GET', PULLS, [{ number: 12 }, { number: 13 }])), /2 open pull requests/);
  });

  it('is stale when the release branch moved past the head ci passed', async () => {
    const outcome = await gateOf(passing().on('GET', `/repos/${REPO}/pulls/12`, pull({ head: { ref: TARGET.head, sha: 'b'.repeat(40), repo: { full_name: REPO } } })));
    assert.equal(outcome.kind, 'stale');
  });

  for (const [what, over, expected] of [
    ['a draft', { draft: true }, /not open and ready/],
    ['a closed one', { state: 'closed' }, /not open and ready/],
    ['another base', { base: { ref: 'next', repo: { full_name: REPO } } }, /does not go into `main`/],
    ['a base in another repository', { base: { ref: 'main', repo: { full_name: 'evil/tool' } } }, /does not go into `main`/],
    ['a head in a fork', { head: { ref: TARGET.head, sha: SHA, repo: { full_name: 'evil/tool' } } }, /head is not this repository's release branch/],
    ['another author', { user: { login: 'someone' } }, /not opened by `github-actions\[bot\]`/],
    ['two commits', { commits: 2 }, /holds 2 commits/],
  ] as const) {
    it(`refuses ${what}`, async () => {
      assert.match(await refusal(passing().on('GET', `/repos/${REPO}/pulls/12`, pull(over))), expected);
    });
  }

  it("refuses a change past the release, naming the files check's reason in a code span", async () => {
    const reason = await refusal(passing(), () => 'src/x.ts is neither `a` version file\nnor the changelog');
    assert.equal(reason, 'the change is more than a release: `src/x.ts is neither a version filenor the changelog`');
  });

  it('refuses a required check that was skipped, and passes a skipped one no rule requires', async () => {
    const runs = [checkRun('every check passed'), checkRun('docs', 'skipped')];
    const github = passing()
      .on('GET', `/repos/${REPO}/rules/branches/main?per_page=100`, rules({ context: 'every check passed' }, { context: 'docs' }))
      .on('GET', checksPath(1), { total_count: 2, check_runs: runs });
    assert.match(await refusal(github), /check `docs` ended `skipped`, and main requires it/);
  });

  it('refuses a pending or failed check whether or not a rule requires it', async () => {
    const pending = [checkRun('every check passed'), checkRun('lint', null)];
    assert.match(await refusal(passing().on('GET', checksPath(1), { total_count: 2, check_runs: pending })), /check `lint` is `in_progress`/);
    const failed = [checkRun('every check passed'), checkRun('lint', 'failure')];
    assert.match(await refusal(passing().on('GET', checksPath(1), { total_count: 2, check_runs: failed })), /check `lint` ended `failure`$/);
  });

  it('refuses when a required check has no run on the head', async () => {
    const github = passing().on('GET', `/repos/${REPO}/rules/branches/main?per_page=100`, rules({ context: 'every check passed' }, { context: 'build' }));
    assert.match(await refusal(github), /main requires check `build`, which has no successful run/);
  });

  it('refuses a summary check reported by another App', async () => {
    const runs = [checkRun('every check passed'), checkRun('every check passed', 'success', { app: { id: 99 } })];
    const github = passing()
      .on('GET', `/repos/${REPO}/rules/branches/main?per_page=100`, rules())
      .on('GET', checksPath(1), { total_count: 2, check_runs: runs });
    assert.match(await refusal(github), /comes from an App other than GitHub Actions/);
  });

  it('reads every page of check runs up to the count GitHub gives', async () => {
    const first = Array.from({ length: 100 }, (_, index) => checkRun(`job ${index}`));
    const github = passing()
      .on('GET', checksPath(1), { total_count: 102, check_runs: first })
      .on('GET', checksPath(2), { total_count: 102, check_runs: [checkRun('every check passed'), checkRun('late', 'failure')] });
    assert.match(await refusal(github), /check `late` ended `failure`/);
  });

  it('refuses when a page of check runs comes back short of the count', async () => {
    const github = passing()
      .on('GET', checksPath(1), { total_count: 3, check_runs: [checkRun('every check passed')] })
      .on('GET', checksPath(2), { total_count: 3, check_runs: [] });
    assert.match(await refusal(github), /the gate could not finish: the check runs read 1 of GitHub's count 3/);
  });

  it('refuses a commit status that is not success once any status exists, and ignores an empty one', async () => {
    assert.match(await refusal(passing().on('GET', `/repos/${REPO}/commits/${SHA}/status`, { state: 'pending', total_count: 1 })), /commit status is `pending`/);
    assert.equal((await gateOf(passing().on('GET', `/repos/${REPO}/commits/${SHA}/status`, { state: 'success', total_count: 2 }))).kind, 'pass');
  });

  it('refuses when GitHub rejects a read or answers in another shape', async () => {
    assert.match(await refusal(passing().on('GET', `/repos/${REPO}/actions/runs/7`, new Error('GitHub answered GET /x with 502'))), /^the gate could not finish: GitHub answered GET \/x with 502$/);
    assert.match(await refusal(passing().on('GET', `/repos/${REPO}/pulls/12`, pull({ commits: '1' }))), /pull\.commits is not a whole number/);
  });
});

describe('requiredChecksOf', () => {
  it('lists the required checks of every ruleset, with the App each names', () => {
    const checks = requiredChecksOf([...rules({ context: 'a', integration_id: 5 }), ...rules({ context: 'b' })]);
    assert.deepEqual(checks, [
      { context: 'a', integrationId: 5 },
      { context: 'b', integrationId: undefined },
    ]);
  });

  it('throws on an integration id that is not a whole number, and on a full page of rules', () => {
    assert.throws(() => requiredChecksOf(rules({ context: 'a', integration_id: '5' })), /integration_id is not a whole number/);
    assert.throws(() => requiredChecksOf(Array.from({ length: 100 }, () => ({ type: 'deletion' }))), /past one page/);
  });
});

describe('checksRefusal', () => {
  const ok = (name: string, appId = ACTIONS_APP_ID): CheckRun => ({ name, status: 'completed', conclusion: 'success', appId });

  it('needs a required check from the App its rule names', () => {
    assert.match(checksRefusal([ok('every check passed'), ok('a', 99)], [{ context: 'a', integrationId: 5 }], 'every check passed') ?? '', /main requires check `a`/);
    assert.equal(checksRefusal([ok('every check passed'), ok('a', 5)], [{ context: 'a', integrationId: 5 }], 'every check passed'), null);
  });

  it('refuses a head with no summary check', () => {
    assert.match(checksRefusal([ok('a')], [], 'every check passed') ?? '', /check `every check passed` did not pass/);
  });
});

describe('codeSpan', () => {
  it('drops backticks and line ends and keeps an empty value a span', () => {
    assert.equal(codeSpan('a`b\r\nc'), '`abc`');
    assert.equal(codeSpan('``'), '` `');
    assert.equal(codeSpan('x'.repeat(200)).length, 122);
  });
});

describe('appJwt', () => {
  it('signs an RS256 token the public key verifies, issued a minute back for nine minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt(42, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1_000);
    const [header = '', payload = '', signature = ''] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), { iat: 940, exp: 1_540, iss: 42 });
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
  });
});

describe('mergeRelease', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { appId: 42, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const target: MergeTarget = { repo: REPO, pr: 12, sha: SHA, checks: 3, paths: ['CHANGELOG.md', 'package.json'], runUrl: 'https://github.com/acme/tool/actions/runs/8' };

  const app = (): FakeGitHub =>
    new FakeGitHub()
      .on('GET', `/repos/${REPO}/installation`, { id: 9 })
      .on('POST', '/app/installations/9/access_tokens', { token: 'install-token' })
      .on('PUT', `/repos/${REPO}/pulls/12/merge`, { merged: true, sha: 'c'.repeat(40) })
      .on('POST', `/repos/${REPO}/issues/12/comments`, { id: 1 })
      .on('DELETE', '/installation/token', null);

  const merge = (github: FakeGitHub) => mergeRelease(target, key, { api: github.api, nowSeconds: () => 1_000 });

  it('mints a token for this repository alone, merges the pinned head by rebase, comments, then revokes the token', async () => {
    const github = app();
    assert.deepEqual(await merge(github), { kind: 'merged', sha: 'c'.repeat(40), commented: true, revoked: true });
    assert.deepEqual(
      github.calls.map((call) => `${call.method} ${call.path}`),
      [`GET /repos/${REPO}/installation`, 'POST /app/installations/9/access_tokens', `PUT /repos/${REPO}/pulls/12/merge`, `POST /repos/${REPO}/issues/12/comments`, 'DELETE /installation/token'],
    );
    const [installation, mint, put, comment, revoke] = github.calls;
    assert.notEqual(installation?.token, 'install-token');
    assert.equal(mint?.token, installation?.token);
    assert.deepEqual(mint?.body, { repositories: ['tool'], permissions: { contents: 'write', pull_requests: 'write' } });
    assert.deepEqual(put?.body, { sha: SHA, merge_method: 'rebase' });
    assert.deepEqual(comment?.body, { body: mergeComment(target) });
    assert.ok([put, comment, revoke].every((call) => call?.token === 'install-token'));
  });

  it('refuses a merge GitHub rejects and still revokes the token', async () => {
    const outcome = await merge(app().on('PUT', `/repos/${REPO}/pulls/12/merge`, new Error('GitHub answered PUT /repos/acme/tool/pulls/12/merge with 409')));
    assert.deepEqual(outcome, { kind: 'refused', reason: 'GitHub refused the merge: GitHub answered PUT /repos/acme/tool/pulls/12/merge with 409', revoked: true });
  });

  it('refuses a merge answer that does not report the merge', async () => {
    const github = app().on('PUT', `/repos/${REPO}/pulls/12/merge`, { merged: false });
    assert.deepEqual(await merge(github), { kind: 'refused', reason: 'GitHub did not report the pull request merged', revoked: true });
    assert.ok(!github.calls.some((call) => call.path.endsWith('/comments')));
  });

  it('reports a failed comment and a failed revoke without retrying the merge', async () => {
    const github = app().on('POST', `/repos/${REPO}/issues/12/comments`, new Error('500')).on('DELETE', '/installation/token', new Error('500'));
    assert.deepEqual(await merge(github), { kind: 'merged', sha: 'c'.repeat(40), commented: false, revoked: false });
    assert.equal(github.calls.filter((call) => call.method === 'PUT').length, 1);
  });

  it('names the head, the paths and the checks in code spans in its comment', () => {
    assert.equal(mergeComment(target), `Merged automatically by teamrig-release at \`${SHA}\`: only \`CHANGELOG.md\`, \`package.json\` changed, 3 checks passed. Gate run: https://github.com/acme/tool/actions/runs/8`);
  });
});

describe('fetchGitHubApi', () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fake =
    (response: () => Response): Fetch =>
    async (url, init) => {
      seen.push({ url, init });
      return response();
    };

  it('sends the token and the JSON body, and parses the answer', async () => {
    const api = fetchGitHubApi(fake(() => new Response('{"ok":1}', { status: 200 })), 'https://api.test');
    assert.deepEqual(await api({ method: 'POST', path: '/x?y=1', token: 't', body: { a: 1 } }), { ok: 1 });
    const last = seen.at(-1);
    assert.equal(last?.url, 'https://api.test/x?y=1');
    assert.equal(last?.init.body, '{"a":1}');
    assert.deepEqual(last?.init.headers, {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer t',
      'user-agent': 'teamrig-release-merge',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    });
  });

  it('answers null for an empty body', async () => {
    const api = fetchGitHubApi(fake(() => new Response(null, { status: 204 })));
    assert.equal(await api({ method: 'DELETE', path: '/installation/token', token: 't' }), null);
  });

  it('rejects any other status, naming the path without its query and never the body', async () => {
    const api = fetchGitHubApi(fake(() => new Response('{"message":"secret detail"}', { status: 404 })));
    await assert.rejects(api({ method: 'GET', path: '/repos/a/b/pulls?head=x', token: 't' }), { message: 'GitHub answered GET /repos/a/b/pulls with 404' });
  });
});
