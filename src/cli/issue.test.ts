import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { withStampFooter } from '../core/stamp.ts';
import { isIssueBodyEdit, isIssueClose, isIssueComment, isIssueRead, isLabelAdd, isLabelFileRead, isLabelRead, isLabelRemove } from '../github/gh.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const LOGIN = 'ACCESS acme: writes with the token saved as teamrig-gh-acme';

describe('teamrig issue comment', () => {
  it('posts one comment through the allowlisted call and writes nothing to the task list', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'comment', 'Acme/Web#612', '--body', 'Thank you! Merged as #624.'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout, [LOGIN, 'COMMENTED acme/web#612']);
    assert.deepEqual(gh.ran.map((request) => request.args), [['api', 'repos/acme/web/issues/612/comments', '-X', 'POST', '-f', `body=${withStampFooter('Thank you! Merged as #624.')}`]]);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('posts the comment as given, with no footer, for a team that turned github.stamp off', async () => {
    const kit = new CliHarness({ ...TEAM, github: { repos: ['acme/web'], stamp: false } });
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'comment', 'acme/web#612', '--body', 'Thank you! Merged as #624.'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(gh.ran.map((request) => request.args.at(-1)), ['body=Thank you! Merged as #624.']);
  });

  it('refuses, running no gh, a caller not on the team, a repository not listed, a bad target, and a body that is empty, secret or names a task id', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const gh = new FakeGh();
    /** Built at runtime so no secret-shaped literal sits in the source. */
    const secret = ['ghp', '_', 'a'.repeat(36)].join('');
    const cases: Array<[readonly string[], Readonly<Record<string, string>>, RegExp]> = [
      [['issue', 'comment', 'acme/web#7', '--body', 'x'], { TEAMRIG_SESSION: 'stranger' }, /^REFUSED stranger is not a session on this team/u],
      [['issue', 'comment', 'acme/api#7', '--body', 'x'], AS_LEAD.env, /^REFUSED acme\/api is not one of the team's repositories: list it under github\.repos in the team config \(now acme\/web\)/u],
      [['issue', 'comment', 'acme/web/issues/7', '--body', 'x'], AS_LEAD.env, /^REFUSED acme\/web\/issues\/7 names no issue or pull request: give it as owner\/name#number/u],
      [['issue', 'comment', 'acme/web#7', '--body', ' '], AS_LEAD.env, /^REFUSED --body is empty/u],
      [['issue', 'comment', 'acme/web#7', '--body', `key ${secret}`], AS_LEAD.env, /^REFUSED --body looks like it holds a secret/u],
      [['issue', 'comment', 'acme/web#7', '--body', 'Done in T12'], AS_LEAD.env, /^REFUSED --body names the task id T12/u],
    ];
    for (const [argv, env, error] of cases) {
      const result = await kit.run(argv, { env, gh });
      const printed = [...result.stdout, ...result.stderr].join('\n');
      assert.equal(result.code, EXIT.refused, `${argv.join(' ')}\n${printed}`);
      assert.match(printed, error, argv.join(' '));
      assert.ok(!printed.includes(secret));
    }
    const missing = await kit.run(['issue', 'comment', 'acme/web#7'], { ...AS_LEAD, gh });
    assert.match([...missing.stdout, ...missing.stderr].join('\n'), /--body is required/u);
    assert.deepEqual(gh.ran, []);
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const gh = new FakeGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['issue', 'comment', 'acme/web#7', '--body', 'x'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
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
