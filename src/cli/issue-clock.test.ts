import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { parseClocks } from '../github/clock.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { commentNode, FakeGh, ghIssue, ghPull, reviewNode } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'], owners: { octocat: 'bravo' } } };
const CLOCKS = join(TEAM_HOME, 'state', 'github-clocks.json');
const HOUR = 3_600_000;

/** The lines of a session's inbox the sync posted, without their date. */
function githubLines(kit: CliHarness, id: string): string[] {
  const text = kit.files.get(join(TEAM_HOME, 'state', 'inbox', `${id}.md`)) ?? '';
  return text.split('\n').flatMap((line) => {
    const at = line.indexOf(' github: ');
    return at < 0 ? [] : [line.slice(at + ' github: '.length)];
  });
}

async function sync(kit: CliHarness, gh: FakeGh): Promise<readonly string[]> {
  const result = await kit.run(['issue', 'sync', '--yes'], { gh });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout;
}

describe('the response clock in issue sync (T3028)', () => {
  it("reminds an outsider's bug's owner once at 75% of 24 h, unwoken, and stops the clock once we answer", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const opened = new Date(kit.clock.now()).toISOString();
    const bug = (comments: readonly JsonRecord[] = []): FakeGh =>
      new FakeGh().holds('acme/web', [ghIssue('acme/web', 9, { labels: ['bug'], authorAssociation: 'NONE', author: 'stranger', createdAt: opened, comments })]);

    await sync(kit, bug());
    assert.deepEqual([...parseClocks(kit.files.get(CLOCKS) ?? '').keys()], ['gh:acme/web#9']);
    assert.deepEqual(githubLines(kit, 'lead'), [], 'no reminder before 18 h');

    kit.clock.advance(18 * HOUR);
    const out = await sync(kit, bug());
    assert.ok(out.includes('REMINDED lead: gh:acme/web#9 waits on an answer'), out.join('\n'));
    const [line] = githubLines(kit, 'lead').filter((text) => text.includes('gh:acme/web#9 (bug)'));
    assert.match(line ?? '', /^GitHub gh:acme\/web#9 \(bug\) has waited 18 h for an answer of ours, since .+; answer it in words on GitHub by .+, its 24 h target, or GH-LATE goes to the lead$/);

    kit.clock.advance(HOUR);
    await sync(kit, bug());
    assert.equal(githubLines(kit, 'lead').filter((text) => text.includes('(bug)')).length, 1, 'reminded once');

    await sync(kit, bug([commentNode(new Date(kit.clock.now()).toISOString(), 'MEMBER', 'User', { login: 'octocat' })]));
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').size, 0, 'answered: the clock stops');
  });

  it('times an outside collaborator as an outsider: their issue starts a clock and their follow-up is no answer (T3380)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const opened = new Date(kit.clock.now()).toISOString();
    const later = new Date(kit.clock.now() + HOUR).toISOString();
    const asked = (answer: JsonRecord): FakeGh =>
      new FakeGh().holds('acme/web', [ghIssue('acme/web', 4, { authorAssociation: 'COLLABORATOR', author: 'contrib', createdAt: opened, comments: [answer] })]);
    await sync(kit, asked(commentNode(later, 'COLLABORATOR', 'User', { login: 'contrib' })));
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').get('gh:acme/web#4')?.since, kit.clock.now(), 'waits since the opening post');

    await sync(kit, asked(commentNode(later, 'MEMBER', 'User', { login: 'OctoCat' })));
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').size, 0, 'a login of github.owners answers, whatever its case');
  });

  it('counts the repository tie as ours when github.owners names no one', async () => {
    const kit = new CliHarness({ ...TEAM, github: { repos: ['acme/web'] } });
    const issue = ghIssue('acme/web', 4, { authorAssociation: 'COLLABORATOR', author: 'contrib', createdAt: new Date(kit.clock.now()).toISOString() });
    await sync(kit, new FakeGh().holds('acme/web', [issue]));
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').size, 0);
  });

  it("times an outside comment on a thread we hold as a comment, owned by the holding task's owner", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const said = new Date(kit.clock.now()).toISOString();
    await sync(kit, new FakeGh().holds('acme/web', [ghIssue('acme/web', 3, { assignees: ['octocat'], comments: [commentNode(said, 'NONE')] })]));
    const clock = parseClocks(kit.files.get(CLOCKS) ?? '').get('gh:acme/web#3');
    assert.deepEqual(clock && { kind: clock.kind, owner: clock.owner, since: clock.since }, { kind: 'comment', owner: 'bravo', since: kit.clock.now() });
  });

  it("times an outsider's pull request as a pull thread of the watcher, reminds at 18 h and is GH-LATE at 24 h (#1351)", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const opened = new Date(kit.clock.now()).toISOString();
    const gh = new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'CONTRIBUTOR', author: 'stranger', head: 'patch-1', fork: true, createdAt: opened, updatedAt: opened })]);
    await sync(kit, gh);
    const clock = parseClocks(kit.files.get(CLOCKS) ?? '').get('gh:acme/web#12');
    assert.deepEqual(clock && { kind: clock.kind, owner: clock.owner, since: clock.since }, { kind: 'pull', owner: 'lead', since: kit.clock.now() });

    kit.clock.advance(18 * HOUR);
    assert.ok((await sync(kit, gh)).includes('REMINDED lead: gh:acme/web#12 waits on an answer'));
    kit.clock.advance(6 * HOUR);
    const check = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' } });
    assert.ok(
      check.stdout.some((line) => line.includes('GH-LATE gh:acme/web#12 (pull, lead) has waited 24 h')),
      check.stdout.join('\n'),
    );
  });

  it('stops a pull request clock at our comment or review; a bot neither starts nor stops it', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const at = (hours: number): string => new Date(kit.clock.now() + hours * HOUR).toISOString();
    const pull = (spec: { readonly comments?: readonly JsonRecord[]; readonly reviews?: readonly JsonRecord[] }): FakeGh =>
      new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'NONE', author: 'stranger', createdAt: at(0), updatedAt: at(0), ...spec })]);
    const running = (): readonly string[] => [...parseClocks(kit.files.get(CLOCKS) ?? '').keys()];

    await sync(kit, pull({ comments: [commentNode(at(0), 'MEMBER', 'Bot')], reviews: [reviewNode(at(0), 'NONE', 'Bot')] }));
    assert.deepEqual(running(), ['gh:acme/web#12'], "a bot's post is no answer of ours");
    await sync(kit, pull({ reviews: [reviewNode(at(0), 'MEMBER', 'User', 'octocat')] }));
    assert.deepEqual(running(), [], 'our review answers it');
    await sync(kit, pull({ reviews: [reviewNode(null, 'MEMBER', 'User', 'octocat')] }));
    assert.deepEqual(running(), ['gh:acme/web#12'], 'a review still pending answers nothing');
    await sync(kit, pull({ comments: [commentNode(at(0), 'OWNER')] }));
    assert.deepEqual(running(), [], 'our comment answers it');
    await sync(kit, new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 13, { authorAssociation: 'NONE', author: 'stranger', comments: [commentNode(at(0), 'NONE', 'Bot')] }), ghPull('acme/web', 14, { authorAssociation: 'NONE', authorKind: 'Bot', state: 'CLOSED' })]));
    assert.deepEqual(running(), ['gh:acme/web#13'], 'an open one waits from its opening; a closed one keeps no clock');
  });

  it("times a collaborator's pull request as an outsider's: it starts a clock and their own follow-up is no answer (#1366)", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const at = (hours: number): string => new Date(kit.clock.now() + hours * HOUR).toISOString();
    const pull = (comments: readonly JsonRecord[]): FakeGh =>
      new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'COLLABORATOR', author: 'contrib', createdAt: at(0), updatedAt: at(0), comments })]);
    const running = (): readonly string[] => [...parseClocks(kit.files.get(CLOCKS) ?? '').keys()];

    await sync(kit, pull([]));
    assert.deepEqual(running(), ['gh:acme/web#12'], 'a collaborator outside github.owners waits on us');
    await sync(kit, pull([commentNode(at(1), 'COLLABORATOR', 'User', { login: 'contrib' })]));
    assert.deepEqual(running(), ['gh:acme/web#12'], 'their follow-up is no answer');
    await sync(kit, pull([commentNode(at(2), 'MEMBER', 'User', { login: 'octocat' })]));
    assert.deepEqual(running(), [], 'a login of github.owners answers it');
  });

  it('keeps no clock on a draft pull request; its wait starts once it is marked ready (#1366)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const opened = new Date(kit.clock.now()).toISOString();
    const pull = (draft: boolean): FakeGh =>
      new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'NONE', author: 'stranger', createdAt: opened, updatedAt: opened, isDraft: draft })]);
    const running = (): readonly string[] => [...parseClocks(kit.files.get(CLOCKS) ?? '').keys()];

    await sync(kit, pull(true));
    assert.deepEqual(running(), [], 'a draft asks nobody to look yet');
    kit.clock.advance(30 * HOUR);
    await sync(kit, pull(true));
    assert.deepEqual(running(), [], 'still a draft past its target: no clock');
    await sync(kit, pull(false));
    assert.deepEqual(running(), ['gh:acme/web#12'], 'marked ready: it waits on us');
  });

  it("keeps a repository's clocks when its pull requests could not be read", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const issue = ghIssue('acme/web', 9, { authorAssociation: 'NONE', createdAt: new Date(kit.clock.now()).toISOString() });
    await sync(kit, new FakeGh().holds('acme/web', [issue]).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'NONE', author: 'stranger' })]));
    const failed = await kit.run(['issue', 'sync', '--yes'], { gh: new FakeGh().holds('acme/web', []).failsPulls('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502\n' }) });
    assert.equal(failed.code, EXIT.failed);
    assert.deepEqual([...parseClocks(kit.files.get(CLOCKS) ?? '').keys()].sort(), ['gh:acme/web#12', 'gh:acme/web#9']);
  });

  it('keeps no clock on a preview, nor for a repository it could not read', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const issue = ghIssue('acme/web', 9, { authorAssociation: 'NONE', createdAt: new Date(kit.clock.now()).toISOString() });
    assert.equal((await kit.run(['issue', 'sync'], { gh: new FakeGh().holds('acme/web', [issue]) })).code, EXIT.ok);
    assert.equal(kit.files.get(CLOCKS), undefined);
    await sync(kit, new FakeGh().holds('acme/web', [issue]));
    const failed = await kit.run(['issue', 'sync', '--yes'], { gh: new FakeGh().answers('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502\n' }) });
    assert.equal(failed.code, EXIT.failed);
    assert.deepEqual([...parseClocks(kit.files.get(CLOCKS) ?? '').keys()], ['gh:acme/web#9'], 'a failed read keeps its clocks');
  });

  it('reminds an owner of 50 outside issues in one line with their count, not one line each (#1475)', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const opened = new Date(kit.clock.now()).toISOString();
    const issues = Array.from({ length: 50 }, (_, index) => ghIssue('acme/web', index + 1, { labels: ['bug'], authorAssociation: 'NONE', author: 'stranger', createdAt: opened }));
    const gh = (): FakeGh => new FakeGh().holds('acme/web', issues);
    await sync(kit, gh());
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').size, 50);
    kit.clock.advance(18 * HOUR);
    const out = await sync(kit, gh());
    assert.deepEqual(out.filter((line) => line.startsWith('REMINDED')), ['REMINDED lead: 50 GitHub threads wait on an answer']);
    const lines = githubLines(kit, 'lead');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0] ?? '', /^50 GitHub threads wait for an answer of ours: gh:acme\/web#1 \(bug, by .+\), gh:acme\/web#2 \(bug, by .+\), gh:acme\/web#3 \(bug, by .+\) and 47 more; /);
    await sync(kit, gh());
    assert.equal(githubLines(kit, 'lead').length, 1, 'reminded once');
  });
});
