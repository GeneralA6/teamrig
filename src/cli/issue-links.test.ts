import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { isIssueQuery, isLinkAdd } from '../adapters/connectors/github/gh.ts';
import { CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const READ_LOGIN = 'ACCESS acme: read with the token saved as teamrig-gh-acme';
const WRITE_LOGIN = 'ACCESS acme: writes with the token saved as teamrig-gh-acme';

/** A whole (#9) planned after two parts (#10, #11) and a task of another repository, as the register holds them. */
async function treeKit(): Promise<CliHarness> {
  const kit = new CliHarness(GITHUB_TEAM);
  const adds = [
    ['--title', 'Part one', '--ref', 'gh:acme/web#10'],
    ['--title', 'Part two', '--ref', 'gh:acme/web#11'],
    ['--title', 'Elsewhere', '--ref', 'gh:acme/api#3'],
    ['--title', 'The whole', '--ref', 'gh:acme/web#9', '--after', 'T1,T2,T3'],
  ];
  for (const fields of adds) {
    const added = await kit.run(['add', ...fields, '--description', 'what and why', '--priority', 'p1'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
  }
  return kit;
}

function repoGh(): FakeGh {
  return new FakeGh().holds('acme/web', [ghIssue('acme/web', 9), ghIssue('acme/web', 10), ghIssue('acme/web', 11, { state: 'CLOSED' }), ghIssue('acme/web', 12)]);
}

const PLAN = ['BLOCKED-BY #9 by #10', 'SUB-ISSUE #10 under #9', 'BLOCKED-BY #9 by #11', 'SUB-ISSUE #11 under #9'];

describe('teamrig issue links', () => {
  it('shows the links the task tree asks for, reading GitHub only and writing nothing anywhere', async () => {
    const kit = await treeKit();
    const log = kit.files.get(EVENTS_PATH);
    const gh = repoGh();
    const result = await kit.run(['issue', 'links'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [
      READ_LOGIN,
      'REPO acme/web: 1 issue(s) to change, 4 link(s) to add, 0 already there',
      'LEFT acme/web: 1 edge(s) to another repository are left for a person',
      ...PLAN,
      'PREVIEW nothing was written; teamrig issue links --yes adds the links above',
    ]);
    assert.ok(gh.ran.every((request) => isIssueQuery(request.args)));
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('adds them with --yes, one allowlisted call each, and a rerun finds them all there', async () => {
    const kit = await treeKit();
    const gh = repoGh();
    const first = await kit.run(['issue', 'links', '--yes'], { ...AS_LEAD, gh });
    assert.equal(first.code, EXIT.ok, [...first.stdout, ...first.stderr].join('\n'));
    assert.deepEqual(first.stdout.slice(-1), ['WROTE 4 link(s) on GitHub; the task list was only read']);
    assert.equal(first.stdout[0], WRITE_LOGIN);
    assert.deepEqual(
      gh.ran.slice(1).map((request) => request.args),
      [
        ['api', 'repos/acme/web/issues/9/dependencies/blocked_by', '-X', 'POST', '-F', 'issue_id=1010'],
        ['api', 'repos/acme/web/issues/9/sub_issues', '-X', 'POST', '-F', 'sub_issue_id=1010'],
        ['api', 'repos/acme/web/issues/9/dependencies/blocked_by', '-X', 'POST', '-F', 'issue_id=1011'],
        ['api', 'repos/acme/web/issues/9/sub_issues', '-X', 'POST', '-F', 'sub_issue_id=1011'],
      ],
    );
    assert.ok(gh.ran.slice(1).every((request) => isLinkAdd(request.args)));
    const again = await kit.run(['issue', 'links', '--yes'], { ...AS_LEAD, gh });
    assert.deepEqual(again.stdout, [
      WRITE_LOGIN,
      'REPO acme/web: 0 issue(s) to change, 0 link(s) to add, 4 already there',
      'LEFT acme/web: 1 edge(s) to another repository are left for a person',
      'WROTE 0 link(s) on GitHub; the task list was only read',
    ]);
  });

  it('stops a repository at its first failed link, and exits 1', async () => {
    const kit = await treeKit();
    const gh = repoGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Server Error (HTTP 502)\n' });
    const result = await kit.run(['issue', 'links', '--yes'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.ok(result.stdout.includes('FAILED acme/web: 0 of 4 link(s) added, then: gh api to add a blocker to acme/web#9 exited with code 1: gh: Server Error (HTTP 502); a rerun adds the rest'), result.stdout.join('\n'));
    assert.equal(gh.ran.filter((request) => isLinkAdd(request.args)).length, 1);
  });

  it('fails a repository GitHub does not show, and refuses one not in github.repos, running no gh', async () => {
    const failed = await (await treeKit()).run(['issue', 'links'], { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(failed.code, EXIT.failed);
    assert.match(failed.stdout.join('\n'), /^FAILED acme\/web: acme\/web is not visible to the token saved as /mu);
    const gh = new FakeGh();
    const refused = await (await treeKit()).run(['issue', 'links', '--repo', 'acme/api'], { ...AS_LEAD, gh });
    assert.equal(refused.code, EXIT.refused);
    assert.match([...refused.stdout, ...refused.stderr].join('\n'), /--repo acme\/api is not one of github\.repos \(acme\/web\)/u);
    assert.deepEqual(gh.ran, []);
  });

  it('says what the links read left out, before the plan', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 9), ghIssue('acme/web', 10), ghIssue('acme/web', 11), { ...ghIssue('acme/web', 12), fullDatabaseId: null }]);
    const result = await (await treeKit()).run(['issue', 'links'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(result.stdout.slice(0, 3), [
      READ_LOGIN,
      'NOTE acme/web: 1 item(s) gh printed did not read as issues with links and were left out',
      'REPO acme/web: 1 issue(s) to change, 4 link(s) to add, 0 already there',
    ]);
  });

  it('fails a repository whose saved key the store cannot read, running no gh, never the gh login in its place', async () => {
    const gh = repoGh();
    const credentials = new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked');
    const result = await (await treeKit()).run(['issue', 'links', '--yes'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout, [
      'FAILED acme/web: could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme',
      'WROTE 0 link(s) on GitHub; the task list was only read',
    ]);
    assert.deepEqual(gh.ran, []);
  });

  it('reads nothing when the machine or the team has GitHub off', async () => {
    const gh = repoGh();
    const off = await (await treeKit()).run(['issue', 'links', '--yes'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.deepEqual(off.stdout, ['OFF TEAMRIG_GITHUB=off turns GitHub off on this machine; nothing was read or written']);
    const none = await new CliHarness().run(['issue', 'links'], { ...AS_LEAD, gh });
    assert.deepEqual(none.stdout, ['OFF no repository to link: list them as "owner/name" under github.repos in the team config; nothing was read or written']);
    assert.deepEqual(gh.ran, []);
  });
});
