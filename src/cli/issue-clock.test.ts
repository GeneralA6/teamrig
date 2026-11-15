import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { parseClocks } from '../github/clock.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { commentNode, FakeGh, ghIssue } from '../testing/fake-gh.ts';
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

    await sync(kit, bug([commentNode(new Date(kit.clock.now()).toISOString(), 'MEMBER')]));
    assert.equal(parseClocks(kit.files.get(CLOCKS) ?? '').size, 0, 'answered: the clock stops');
  });

  it("times an outside comment on a thread we hold as a comment, owned by the holding task's owner", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const said = new Date(kit.clock.now()).toISOString();
    await sync(kit, new FakeGh().holds('acme/web', [ghIssue('acme/web', 3, { assignees: ['octocat'], comments: [commentNode(said, 'NONE')] })]));
    const clock = parseClocks(kit.files.get(CLOCKS) ?? '').get('gh:acme/web#3');
    assert.deepEqual(clock && { kind: clock.kind, owner: clock.owner, since: clock.since }, { kind: 'comment', owner: 'bravo', since: kit.clock.now() });
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
});
