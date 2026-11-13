import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { isIssueClose, isIssueComment } from './gh.ts';
import { GitHubIssueHost } from './host.ts';
import { RepoTokens } from './tokens.ts';

const ENV = { HOME: '/u' };
const TARGET = { repo: 'acme/web', number: 7 };

function hostWith(gh: FakeGh, credentials: FakeCredentials = new FakeCredentials()): GitHubIssueHost {
  return new GitHubIssueHost(gh, new RepoTokens(credentials, ENV), new SecretScanner(['tok_[a-z0-9]{8}']));
}

describe('GitHubIssueHost', () => {
  it("comments and closes through the allowlisted calls, with the owner's token in gh's environment only", async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token'));
    assert.deepEqual(await host.reach('acme/web'), { kind: 'reached', access: 'acme: writes with the token saved as teamrig-gh-acme' });
    assert.deepEqual(await host.comment(TARGET, 'Thanks'), { kind: 'done' });
    assert.deepEqual(await host.close(TARGET), { kind: 'done' });
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/7/comments', '-X', 'POST', '-f', 'body=Thanks'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed'],
    ]);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
  });

  it('writes with the gh login when no token is saved, and says so', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh);
    assert.deepEqual(await host.reach('acme/web'), { kind: 'reached', access: 'acme: writes with the gh login; no token saved as teamrig-gh-acme' });
    assert.deepEqual(await host.close(TARGET), { kind: 'done' });
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], undefined);
  });

  it('reaches nothing and runs no gh when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const host = hostWith(gh, new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked'));
    const reason = 'could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme';
    assert.deepEqual(await host.reach('acme/web'), { kind: 'unreachable', reason });
    assert.deepEqual(await host.comment(TARGET, 'Thanks'), { kind: 'failed', reason });
    assert.deepEqual(await host.close(TARGET), { kind: 'failed', reason });
    assert.deepEqual(gh.ran, []);
  });

  it('says how to fix a token that may not write, and redacts a secret shape in gh error text', async () => {
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n' });
    assert.deepEqual(await hostWith(denied, new FakeCredentials().saves('teamrig-gh-acme', 'k')).close(TARGET), {
      kind: 'failed',
      reason: 'the token saved as teamrig-gh-acme may not close acme/web#7: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again',
    });
    const secret = ['tok', '_abcd1234'].join('');
    const odd = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: `gh: unexpected ${secret}\n` });
    const end = await hostWith(odd).comment(TARGET, 'Thanks');
    assert.equal(end.kind, 'failed');
    assert.ok(end.kind === 'failed' && !end.reason.includes(secret) && end.reason.startsWith('gh api to comment on acme/web#7 exited with code 1: gh: unexpected [redacted'));
  });

  it('names an issue not there, a gh that could not start, and one stopped by a signal', async () => {
    const missing = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' });
    assert.deepEqual(await hostWith(missing).close(TARGET), { kind: 'failed', reason: 'acme/web#7 is not there for the gh login: check the number, and that the token reaches acme/web' });
    const absent = new FakeGh().failsWith(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const notInstalled = await hostWith(absent).close(TARGET);
    assert.ok(notInstalled.kind === 'failed' && notInstalled.reason.startsWith('gh, the GitHub CLI, is not installed'));
    const stopped = new FakeGh().failsWrite({ end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(stopped).comment(TARGET, 'Thanks'), { kind: 'failed', reason: 'gh was stopped (SIGTERM) on its way to comment on acme/web#7: look on GitHub before a rerun' });
  });
});
