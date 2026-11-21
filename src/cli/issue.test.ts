import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { withStampFooter } from '../core/stamp.ts';
import { isAreaLabelCreate, isIssueAssign, isIssueAssigneeRead, isIssueBodyEdit, isIssueClose, isIssueComment, isIssueRead, isIssueUnassign, isLabelAdd, isLabelFileRead, isLabelRead, isLabelRemove, isUserRead, labelCreateArgs } from '../github/gh.ts';
import { areaLabelSpec } from '../issues/managed-labels.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { rotateRegister } from '../testing/rotation.ts';
import { EXIT } from './runtime.ts';

const DAY_MS = 86_400_000;
const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const LOGIN = 'ACCESS acme: writes with the token saved as teamrig-gh-acme';

describe('teamrig issue reply (T3169)', () => {
  const REPLY = join(APP, 'reply.md');

  /** A team with the lead's task holding acme/web#922 (T1) and the reply's text in reply.md; github is the team's github section. */
  async function replyKit(github: JsonRecord = { repos: ['acme/web'] }): Promise<CliHarness> {
    const kit = new CliHarness({ ...TEAM, github });
    const added = await kit.run(['add', '--title', 'Picked-up issue', '--description', 'Work tracked on an issue.', '--priority', 'p2', '--ref', 'gh:acme/web#922'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
    await kit.files.write(REPLY, 'Picking this up.');
    return kit;
  }

  /** #922 as it stood: open, status:open, no one assigned. */
  function stale(): FakeGh {
    return new FakeGh().holds('acme/web', [ghIssue('acme/web', 922, { labels: ['status:open'] })]).hasLabels('acme/web', ['status:open', 'status:in progress']);
  }

  it('on #922 sets the task, then the status label and the assignee, and posts the comment last', async () => {
    const kit = await replyKit();
    const gh = stale();
    const result = await kit.run(['issue', 'reply', 'acme/web#922', '--body-file', 'reply.md', '--status', 'in progress', '--note', 'picked up'], { ...AS_LEAD, gh });
    const printed = [...result.stdout, ...result.stderr].join('\n');
    assert.equal(result.code, EXIT.ok, printed);
    // The lead maps to no login, so the push assigns the token's own user, as the repository push does (T4581).
    assert.match(printed, /SET acme\/web#922 T1 in-progress: add status:in progress, take off status:open, assign sync-bot$/mu);
    const writes = gh.ran.map((request) => request.args).filter((args) => !isIssueRead(args) && !isLabelRead(args));
    assert.ok(writes.some(isLabelAdd) && writes.some(isLabelRemove), printed);
    assert.deepEqual(writes.at(-1), ['api', 'repos/acme/web/issues/922/comments', '-X', 'POST', '-f', `body=${withStampFooter('Picking this up.')}`]);
    assert.ok(writes.slice(0, -1).every((args) => !isIssueComment(args)));
    const list = await kit.run(['list', '--session', 'lead'], AS_LEAD);
    assert.match(list.stdout.join('\n'), /T1 in-progress/u);
  });

  it('posts the reply as given, with no footer, for a team that turned github.stamp off', async () => {
    const kit = await replyKit({ repos: ['acme/web'], stamp: false });
    const gh = stale();
    const result = await kit.run(['issue', 'reply', 'acme/web#922', '--body-file', 'reply.md'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    const comments = gh.ran.map((request) => request.args).filter(isIssueComment);
    assert.deepEqual(comments.map((args) => args.at(-1)), ['body=Picking this up.']);
  });

  it('writes nothing to the thread when the task may not be set, and nothing anywhere when no task holds the issue', async () => {
    const kit = await replyKit();
    const gh = stale();
    const bogus = await kit.run(['issue', 'reply', 'acme/web#922', '--body-file', 'reply.md', '--status', 'finished'], { ...AS_LEAD, gh });
    assert.notEqual(bogus.code, EXIT.ok);
    const held = new FakeGh().holds('acme/web', [ghIssue('acme/web', 5)]);
    const unheld = await kit.run(['issue', 'reply', 'acme/web#5', '--body-file', 'reply.md'], { ...AS_LEAD, gh: held });
    assert.equal(unheld.code, EXIT.refused);
    assert.match(unheld.stdout.join('\n'), /no task holds acme\/web#5, so the reply has no status to show/u);
    for (const ran of [gh, held]) {
      assert.ok(ran.ran.every((request) => isIssueRead(request.args) || isLabelRead(request.args)), 'the refused reply wrote to GitHub');
    }
  });

  it('writes nothing anywhere when two active tasks share the issue, as the status push speaks for neither (#1449)', async () => {
    const kit = await replyKit();
    const second = await kit.run(['add', '--title', 'Follow-up on the issue', '--description', 'More work on the same issue.', '--priority', 'p2', '--ref', 'gh:acme/web#922'], AS_LEAD);
    assert.equal(second.code, EXIT.ok, [...second.stdout, ...second.stderr].join('\n'));
    const gh = stale();
    const result = await kit.run(['issue', 'reply', 'acme/web#922', '--body-file', 'reply.md', '--status', 'in progress'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
    assert.match(result.stdout.join('\n'), /T1, T2 all hold acme\/web#922, so no one task's status speaks for it/u);
    assert.ok(gh.ran.every((request) => isIssueRead(request.args) || isLabelRead(request.args)), 'the refused reply wrote to GitHub');
    const list = await kit.run(['list', '--session', 'lead'], AS_LEAD);
    assert.doesNotMatch(list.stdout.join('\n'), /in-progress/u);
  });

  it('refuses, running no gh, a caller not on the team, a repository not listed, a bad target or --pr, a body that is empty, secret or names a task id, and set flags without --status', async () => {
    const kit = await replyKit();
    const gh = new FakeGh();
    /** Built at runtime so no secret-shaped literal sits in the source. */
    const secret = ['ghp', '_', 'a'.repeat(36)].join('');
    await kit.files.write(join(APP, 'empty.md'), ' ');
    await kit.files.write(join(APP, 'secret.md'), `key ${secret}`);
    await kit.files.write(join(APP, 'task.md'), 'Done in T12');
    const reply = (target: string, file: string, ...more: string[]): string[] => ['issue', 'reply', target, '--body-file', file, ...more];
    const cases: Array<[readonly string[], Readonly<Record<string, string>>, RegExp]> = [
      [reply('acme/web#7', 'reply.md'), { TEAMRIG_SESSION: 'stranger' }, /^REFUSED stranger is not a session on this team/u],
      [reply('acme/api#7', 'reply.md'), AS_LEAD.env, /^REFUSED acme\/api is not one of the team's repositories/u],
      [reply('acme/web/issues/7', 'reply.md'), AS_LEAD.env, /^REFUSED acme\/web\/issues\/7 names no issue or pull request/u],
      [reply('acme/web#7', 'reply.md', '--pr', 'latest'), AS_LEAD.env, /^REFUSED --pr latest is no pull request number/u],
      [reply('acme/web#7', 'empty.md'), AS_LEAD.env, /^REFUSED --body-file is empty/u],
      [reply('acme/web#7', 'secret.md'), AS_LEAD.env, /^REFUSED --body-file looks like it holds a secret/u],
      [reply('acme/web#7', 'task.md'), AS_LEAD.env, /^REFUSED --body-file names the task id T12/u],
      [reply('acme/web#7', 'reply.md', '--followup', 'Done in T12'), AS_LEAD.env, /^REFUSED --followup names the task id T12/u],
      [reply('acme/web#7', 'reply.md', '--note', 'x'), AS_LEAD.env, /^REFUSED --note go to the task with --status/u],
    ];
    for (const [argv, env, error] of cases) {
      const result = await kit.run(argv, { env, gh });
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, `${argv.join(' ')}\n${printed}`);
      assert.match(printed, error, argv.join(' '));
      assert.ok(!printed.includes(secret));
    }
    assert.deepEqual(gh.ran, []);
  });

  it('is the only comment a session posts: issue comment is no command', async () => {
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'comment', 'acme/web#7', '--body', 'x'], { ...AS_LEAD, gh: new FakeGh() });
    assert.notEqual(result.code, EXIT.ok);
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const kit = await replyKit();
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'reply', 'acme/web#922', '--body-file', 'reply.md'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});

describe('teamrig issue close', () => {
  it("comments, then closes, with the owner's token, never printing it", async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token');
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#612', '--comment', 'Closing in favour of #624.'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, ['ACCESS acme: writes with the token saved as teamrig-gh-acme', 'COMMENTED acme/web#612', 'CLOSED acme/web#612']);
    assert.equal(gh.ran.length, 2);
    assert.ok(isIssueComment(gh.ran[0]?.args ?? []) && isIssueClose(gh.ran[1]?.args ?? []));
    assert.deepEqual(gh.ran.map((request) => request.env['GH_TOKEN']), ['acme-issues-token', 'acme-issues-token']);
    assert.ok(![...result.stdout, ...result.stderr].some((line) => line.includes('acme-issues-token')));
  });

  it('closes with the reason given, in the word GitHub uses, and refuses one it does not know', async () => {
    const gh = new FakeGh();
    const kit = new CliHarness(GITHUB_TEAM);
    const result = await kit.run(['issue', 'close', 'acme/web#7', '--reason', 'not-planned'], { ...AS_LEAD, gh });
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7 as not-planned']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=not_planned']]);
    const refused = await kit.run(['issue', 'close', 'acme/web#7', '--reason', 'reopened'], { ...AS_LEAD, gh });
    assert.equal(refused.code, EXIT.refused);
    assert.match([...refused.stdout, ...refused.stderr].join('\n'), /--reason takes completed, not-planned, duplicate, not "reopened"/u);
    assert.equal(gh.ran.length, 1);
  });

  it('closes as a duplicate of an issue of the same repository, naming it by the id GitHub gives for it', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 3)]);
    const kit = new CliHarness(GITHUB_TEAM);
    const result = await kit.run(['issue', 'close', 'acme/web#7', '--duplicate-of', 'Acme/Web#3'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7 as duplicate of acme/web#3']);
    assert.deepEqual(gh.ran.map((request) => request.args), [
      ['api', 'repos/acme/web/issues/3', '-X', 'GET'],
      ['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=duplicate', '-F', 'duplicate_issue_id=1003'],
    ]);
    const named = await kit.run(['issue', 'close', 'acme/web#8', '--reason', 'duplicate', '--duplicate-of', 'acme/web#3'], { ...AS_LEAD, gh });
    assert.deepEqual(named.stdout, [LOGIN, 'CLOSED acme/web#8 as duplicate of acme/web#3']);
  });

  it('writes nothing, not even the comment, when GitHub has no such original', async () => {
    const gh = new FakeGh().holds('acme/web', []);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7', '--comment', 'Same as #3.', '--duplicate-of', 'acme/web#3'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), ['FAILED acme/web#7: acme/web#3 is no issue the access can see: name an existing one as the original; nothing was written']);
    assert.equal(gh.ran.length, 1);
    assert.ok(isIssueRead(gh.ran[0]?.args ?? []));
  });

  it('refuses, running no gh, --duplicate-of with another reason, naming no issue, one of another repository, or the issue itself', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    const cases: Array<[readonly string[], RegExp]> = [
      [['--reason', 'completed', '--duplicate-of', 'acme/web#3'], /--duplicate-of closes as a duplicate, so it takes no --reason completed/u],
      [['--duplicate-of', 'web#3'], /--duplicate-of web#3 names no issue: give it as owner\/name#number/u],
      [['--duplicate-of', 'acme/api#3'], /--duplicate-of names an issue of acme\/api: name one of acme\/web/u],
      [['--duplicate-of', 'acme/web#7'], /--duplicate-of names acme\/web#7 itself/u],
    ];
    for (const [flags, error] of cases) {
      const result = await kit.run(['issue', 'close', 'acme/web#7', ...flags], { ...AS_LEAD, gh });
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, `${flags.join(' ')}\n${printed}`);
      assert.match(printed, error, flags.join(' '));
    }
    assert.deepEqual(gh.ran, []);
  });

  it('closes with no comment when none is given', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.deepEqual(result.stdout, [LOGIN, 'CLOSED acme/web#7']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/7', '-X', 'PATCH', '-f', 'state=closed']]);
  });

  it('stops, running no gh, when the store holds the key but cannot read it', async () => {
    const gh = new FakeGh();
    const credentials = new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked');
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh, credentials });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout, [
      'FAILED acme/web#7: could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme; nothing was written',
    ]);
    assert.deepEqual(gh.ran, []);
  });

  it('fails, closing nothing, when GitHub refuses the comment', async () => {
    const gh = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'close', 'acme/web#7', '--comment', 'Thanks'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), [
      'FAILED acme/web#7: the token saved as teamrig-gh-acme may not comment on acme/web#7: on GitHub, edit that token and set Issues and Pull requests to Read and write; its text stays the same, so nothing needs saving again; it was not closed',
    ]);
    assert.equal(gh.ran.length, 1);
  });
});

describe('teamrig issue label', () => {
  it('reads that each label to add is the repository, adds them, then takes off each to remove, by allowlisted calls', async () => {
    const gh = new FakeGh().hasLabels('acme/web', ['type: bug', 'p1']);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'label', 'acme/web#7', '--add', 'type: bug, p1,p1', '--remove', 'needs triage'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [LOGIN, 'LABELED acme/web#7: "type: bug", "p1"', 'UNLABELED acme/web#7: "needs triage"']);
    const [first, second, add, remove] = gh.ran.map((request) => request.args);
    assert.ok(isLabelRead(first ?? []) && isLabelRead(second ?? []) && isLabelAdd(add ?? []) && isLabelRemove(remove ?? []));
    assert.equal(gh.ran.length, 4);
  });

  it('fails, changing nothing, when a label to add is not one of the repository', async () => {
    const gh = new FakeGh().hasLabels('acme/web', ['p1']);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'label', 'acme/web#7', '--add', 'tpye: bug'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.deepEqual(result.stdout.slice(1), ['FAILED acme/web#7: acme/web has no label "tpye: bug", and it has no .github/labels.json: add it to that file or make it there first, as adding it here would make a new one; nothing was changed']);
    assert.ok(gh.ran.every((request) => isLabelRead(request.args) || isLabelFileRead(request.args)));
  });

  it("makes a missing label the repository's .github/labels.json defines, then adds it (T3206)", async () => {
    const file = JSON.stringify({ labels: [{ name: 'area:cli', color: '1d76db', description: 'Area: the teamrig command line' }] });
    const gh = new FakeGh().hasLabels('acme/web', ['p1']).holdsLabelFile('acme/web', file);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'label', 'acme/web#7', '--add', 'area:cli'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('MADE acme/web: the label "area:cli", as its .github/labels.json names it'), result.stdout.join('\n'));
    const create = gh.ran.find((request) => request.args.includes('-X') && request.args.includes('repos/acme/web/labels'));
    assert.deepEqual(create?.args, ['api', 'repos/acme/web/labels', '-X', 'POST', '-f', 'name=area:cli', '-f', 'color=1d76db', '-f', 'description=Area: the teamrig command line']);
    assert.ok(gh.ran.some((request) => isLabelAdd(request.args)));
  });

  it("makes a missing label the team config's github.areaOwners names, in the area look, then adds it (T4053)", async () => {
    const team: JsonRecord = { ...TEAM, github: { repos: ['acme/web'], areaOwners: { 'Area:Pane': 'lead' } } };
    const gh = new FakeGh().hasLabels('acme/web', ['p1']);
    const result = await new CliHarness(team).run(['issue', 'label', 'acme/web#7', '--add', 'area:pane'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.ok(result.stdout.includes(`MADE acme/web: the label "area:pane", as the team config's github.areaOwners names it`), result.stdout.join('\n'));
    assert.deepEqual(gh.ran.find((request) => isAreaLabelCreate(request.args))?.args, labelCreateArgs('acme/web', areaLabelSpec('area:pane')));
    assert.ok(gh.ran.some((request) => isLabelAdd(request.args)));
  });

  it('refuses, running no gh, no list, a label in both, an empty or control-character label, and a repository not listed', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    const cases: Array<[readonly string[], RegExp]> = [
      [['issue', 'label', 'acme/web#7'], /^REFUSED issue label needs --add or --remove/u],
      [['issue', 'label', 'acme/web#7', '--add', 'p1', '--remove', 'p2,p1'], /^REFUSED the label "p1" is in both --add and --remove/u],
      [['issue', 'label', 'acme/web#7', '--add', 'p1,,p2'], /^REFUSED --add: a label name is empty/u],
      [['issue', 'label', 'acme/web#7', '--remove', 'p\u00071'], /^REFUSED --remove: the label "p\\u00071" holds a control character/u],
      [['issue', 'label', 'acme/api#7', '--add', 'p1'], /^REFUSED acme\/api is not one of the team's repositories/u],
    ];
    for (const [argv, error] of cases) {
      const result = await kit.run(argv, { ...AS_LEAD, gh });
      assert.equal(result.code, EXIT.refused, argv.join(' '));
      assert.match([...result.stdout, ...result.stderr].join('\n'), error, argv.join(' '));
    }
    assert.deepEqual(gh.ran, []);
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'label', 'acme/web#7', '--remove', 'p1'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});

describe('teamrig issue assign (T3228)', () => {
  it('reads the item, its labels and each login on it, then assigns and takes off by allowlisted calls', async () => {
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]).spells('OctoCat').cannotAssign('acme/web', ['OctoCat']).tookPart('acme/web', 7, ['OctoCat']);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'assign', 'acme/web#7', '--add', '@octocat, OCTOCAT', '--remove', 'mallory'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [LOGIN, 'ASSIGNED acme/web#7: OctoCat', 'UNASSIGNED acme/web#7: mallory']);
    const [labels, user, assignable, assign, unassign] = gh.ran.map((request) => request.args);
    assert.ok(isIssueRead(labels ?? []) && isUserRead(user ?? []) && isIssueAssigneeRead(assignable ?? []) && isIssueAssign(assign ?? []) && isIssueUnassign(unassign ?? []));
    assert.equal(gh.ran.length, 5);
  });

  it('refuses, assigning no one, on a design issue and for a login GitHub would drop', async () => {
    const design = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { labels: ['design'] })]);
    const refused = await new CliHarness(GITHUB_TEAM).run(['issue', 'assign', 'acme/web#7', '--add', 'octocat'], { ...AS_LEAD, gh: design });
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout.join('\n'), /REFUSED acme\/web#7: it is a design issue/u);
    assert.ok(design.ran.every((request) => isIssueRead(request.args)));
    const stranger = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7)]).cannotAssign('acme/web', ['ghost']);
    const dropped = await new CliHarness(GITHUB_TEAM).run(['issue', 'assign', 'acme/web#7', '--add', 'ghost'], { ...AS_LEAD, gh: stranger });
    assert.equal(dropped.code, EXIT.refused);
    assert.match(dropped.stdout.join('\n'), /REFUSED acme\/web#7: ghost may not be assigned to it/u);
    assert.ok(!stranger.ran.some((request) => isIssueAssign(request.args)));
  });

  it('fails, assigning no one, when GitHub shows no such item', async () => {
    const gh = new FakeGh().holds('acme/web', []);
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'assign', 'acme/web#7', '--add', 'octocat'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout.join('\n'), /FAILED acme\/web#7: GitHub shows no such issue or pull request; nothing was changed/u);
  });

  it('refuses, running no gh, no list, a login in both, a bad login, too many, and a repository not listed', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    const cases: Array<[readonly string[], RegExp]> = [
      [['issue', 'assign', 'acme/web#7'], /^REFUSED issue assign needs --add or --remove/u],
      [['issue', 'assign', 'acme/web#7', '--add', 'octocat', '--remove', 'OctoCat'], /^REFUSED octocat is in both --add and --remove/u],
      [['issue', 'assign', 'acme/web#7', '--add', 'a,,b'], /^REFUSED --add: a login is empty/u],
      [['issue', 'assign', 'acme/web#7', '--remove', 'octo cat'], /^REFUSED --remove: the login "octo cat" holds a space/u],
      [['issue', 'assign', 'acme/web#7', '--add', 'a,b', '--remove', 'c,d'], /^REFUSED issue assign takes at most 3 logins in all, not 4/u],
      [['issue', 'assign', 'acme/api#7', '--add', 'octocat'], /^REFUSED acme\/api is not one of the team's repositories/u],
    ];
    for (const [argv, error] of cases) {
      const result = await kit.run(argv, { ...AS_LEAD, gh });
      assert.equal(result.code, EXIT.refused, argv.join(' '));
      assert.match([...result.stdout, ...result.stderr].join('\n'), error, argv.join(' '));
    }
    assert.deepEqual(gh.ran, []);
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'assign', 'acme/web#7', '--add', 'octocat'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});

describe('teamrig issue edit', () => {
  const SPEC = join(APP, 'spec.md');
  const BODY = '## Spec\n\nStep one: run `npm test` $(x) @file\n';

  it('replaces the body with the file, resolved from the working folder, through the allowlisted call', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const log = kit.files.get(EVENTS_PATH);
    await kit.files.write(SPEC, BODY);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'edit', 'Acme/Web#612', '--body-file', 'spec.md'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [LOGIN, `EDITED acme/web#612: its body is now ${BODY.length} characters`]);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/612', '-X', 'PATCH', '-f', `body=${withStampFooter(BODY)}`]]);
    assert.ok(isIssueBodyEdit(gh.ran[0]?.args ?? []));
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it("drops a byte-order mark an editor wrote at the file's start", async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await kit.files.write(SPEC, `\uFEFF${BODY}`);
    const gh = new FakeGh();
    await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', SPEC], { ...AS_LEAD, gh });
    assert.deepEqual(gh.ran.map((request) => request.args.at(-1)), [`body=${withStampFooter(BODY)}`]);
  });

  it('refuses, running no gh, no file, a missing file, and a body that is empty, secret or names a task id', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    /** Built at runtime so no secret-shaped literal sits in the source. */
    const secret = ['ghp', '_', 'a'.repeat(36)].join('');
    const files: Array<[string, RegExp]> = [
      [' \n', /^REFUSED --body-file is empty/u],
      [`key ${secret}`, /^REFUSED --body-file looks like it holds a secret/u],
      ['Done in T12', /^REFUSED --body-file names the task id T12/u],
    ];
    for (const [text, error] of files) {
      await kit.files.write(SPEC, text);
      const result = await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', SPEC], { ...AS_LEAD, gh });
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, printed);
      assert.match(printed, error);
      assert.ok(!printed.includes(secret));
    }
    const missing = await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', 'gone.md'], { ...AS_LEAD, gh });
    assert.equal(missing.code, EXIT.refused);
    assert.match([...missing.stdout, ...missing.stderr].join('\n'), /^REFUSED no file .*gone\.md: --body-file takes the file holding the new body/u);
    const none = await kit.run(['issue', 'edit', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.match([...none.stdout, ...none.stderr].join('\n'), /--body-file is required/u);
    await kit.files.write(SPEC, BODY);
    const unlisted = await kit.run(['issue', 'edit', 'acme/api#7', '--body-file', SPEC], { ...AS_LEAD, gh });
    assert.match([...unlisted.stdout, ...unlisted.stderr].join('\n'), /^REFUSED acme\/api is not one of the team's repositories/u);
    assert.deepEqual(gh.ran, []);
  });

  it('refuses, before reading it, a file the secret guard keeps, naming the flag and never the text', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    for (const given of ['.env', join('deploy', 'id_rsa')]) {
      const result = await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', given], { ...AS_LEAD, gh });
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, printed);
      assert.match(printed, /^REFUSED --body-file names a file the secret guard keeps \(secretGuard\.paths\): .* is never read or posted/u);
    }
    await kit.files.write(SPEC, BODY);
    assert.equal((await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', SPEC], { ...AS_LEAD, gh })).code, EXIT.ok);
    assert.equal(gh.ran.length, 1);
  });

  it('fails, saying the body stayed, when GitHub refuses the edit, and writes nothing while GitHub is off', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await kit.files.write(SPEC, BODY);
    const denied = new FakeGh().failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    const failed = await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', SPEC], { ...AS_LEAD, gh: denied });
    assert.equal(failed.code, EXIT.failed);
    assert.match(failed.stdout.join('\n'), /^FAILED acme\/web#7: the token saved as teamrig-gh-acme may not edit the body of acme\/web#7: .*; the body is as it was$/mu);
    const gh = new FakeGh();
    const off = await kit.run(['issue', 'edit', 'acme/web#7', '--body-file', SPEC], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(off.code, EXIT.ok);
    assert.match(off.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});

describe('teamrig issue similar', () => {
  /** A task to add: its title, its description, and the issue it mirrors, if any. */
  type Seed = readonly [title: string, description: string, ref: string | undefined];

  /** A team holding `tasks`, added in order as T1, T2 and on. */
  async function teamWith(tasks: readonly Seed[], team: JsonRecord = GITHUB_TEAM): Promise<CliHarness> {
    const kit = new CliHarness(team);
    for (const [title, description, ref] of tasks) {
      const added = await kit.run(['add', '--title', title, '--description', description, '--priority', 'p1', ...(ref === undefined ? [] : ['--ref', ref])], AS_LEAD);
      assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
    }
    return kit;
  }

  /** Three mirrored issues (T1-T3), two of them about the same crash, and one task with no issue (T4). */
  function seeded(team: JsonRecord = GITHUB_TEAM): Promise<CliHarness> {
    return teamWith(
      [
        ['Login page crashes on submit', 'The login page crashes when the form is submitted with an empty password.', 'gh:acme/web#7'],
        ['Login crashes on submit with an empty password', 'Submitting the login form with no password crashes the page.', 'gh:acme/web#8'],
        ['Dark theme colours for the settings menu', 'The settings menu needs its own dark theme colours.', 'gh:acme/web#9'],
        ['The login page crashes on submit', 'A team task with no issue behind it: the login page crashes on submit.', undefined],
      ],
      team,
    );
  }

  it('compares the bodies a compaction left out of the snapshot, read from the history (T4781)', async () => {
    // Alike only in their bodies: with the bodies missing, no title word is shared and nothing matches. The bodies
    // are long enough to outweigh the titles, whose words count twice and are shared by neither.
    const crash = 'The login page crashes when the form is submitted with an empty password';
    const trace = 'the browser console shows a null reference error in the validation script.';
    const kit = await teamWith([
      ['Sign-in is broken', `${crash}: ${trace}`, 'gh:acme/web#7'],
      ['Report from a customer', `${crash} field: ${trace}`, 'gh:acme/web#8'],
      ['Dark theme colours for the settings menu', 'The settings menu needs its own dark theme colours.', 'gh:acme/web#9'],
    ]);
    kit.clock.advance(3 * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const result = await kit.run(['issue', 'similar', 'acme/web#7'], AS_LEAD);
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(result.stdout[0], 'SIMILAR acme/web#7 (T1): 1 of 2 mirrored issues at or above 0.35 (github.similarThreshold)');
    assert.match(result.stdout[1] ?? '', / acme\/web#8 T2 Report from a customer$/u);
  });

  it("lists the issue's likely duplicates among the mirrored ones, best first, reading only the task list", async () => {
    const kit = await seeded();
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'similar', 'Acme/Web#7'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.equal(result.stdout[0], 'SIMILAR acme/web#7 (T1): 1 of 2 mirrored issues at or above 0.35 (github.similarThreshold)');
    assert.match(result.stdout[1] ?? '', /^(?:0\.(?:3[5-9]|[4-9]\d)|1\.00) acme\/web#8 T2 Login crashes on submit with an empty password$/u);
    assert.equal(result.stdout.length, 2);
    assert.deepEqual(gh.ran, []);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('says none when no mirrored issue reaches github.similarThreshold', async () => {
    const unrelated = await (await seeded()).run(['issue', 'similar', 'acme/web#9'], AS_LEAD);
    assert.equal(unrelated.code, EXIT.ok);
    assert.deepEqual(unrelated.stdout, ['SIMILAR acme/web#9 (T3): none of 2 mirrored issues at or above 0.35 (github.similarThreshold)']);
    const strict = await (await seeded({ ...TEAM, github: { repos: ['acme/web'], similarThreshold: 0.99 } })).run(['issue', 'similar', 'acme/web#7'], AS_LEAD);
    assert.deepEqual(strict.stdout, ['SIMILAR acme/web#7 (T1): none of 2 mirrored issues at or above 0.99 (github.similarThreshold)']);
  });

  it('refuses an issue the task list does not mirror, and a bad target', async () => {
    const kit = await seeded();
    const missing = await kit.run(['issue', 'similar', 'acme/web#99'], AS_LEAD);
    assert.equal(missing.code, EXIT.refused);
    assert.match([...missing.stdout, ...missing.stderr].join('\n'), /^REFUSED acme\/web#99 is not in the task list: teamrig issue sync adds a task for each open issue of github\.repos/u);
    const bad = await kit.run(['issue', 'similar', 'web#7'], AS_LEAD);
    assert.equal(bad.code, EXIT.refused);
    assert.match([...bad.stdout, ...bad.stderr].join('\n'), /^REFUSED web#7 names no issue or pull request/u);
  });
});
