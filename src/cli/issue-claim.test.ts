import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { isCommentsRead, isIssueAssign, isIssueBodyEdit, isIssueClose, isIssueComment, isIssueCreate, isIssueUnassign, isLabelAdd, isLabelCreate, isLabelRemove, isLinkAdd } from '../github/gh.ts';
import { CLAIM_DAYS, CLAIM_READS, CLAIMS_PER_DAY, formatClaims, parseClaims } from '../issues/claim.ts';
import { autoPushWrites } from '../issues/status-push.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { commentNode, FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { CLAIM_REPLY, claimWrites, RELEASE_REPLY } from './commands/issue-claim.ts';
import { EXIT } from './runtime.ts';

const REPO = 'acme/web';
const CLAIMS = join(TEAM_HOME, 'state', 'github-claims.json');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function team(statusPush: boolean): JsonRecord {
  return { ...TEAM, github: { repos: [REPO], owners: { octocat: 'bravo' }, statusPush, probeSeconds: 300 } };
}

/** The GitHub writes a run made: assigns, unassigns, comments and label writes, as command lines. */
function writes(gh: FakeGh, kind: (args: readonly string[]) => boolean): string[] {
  return gh.ran.filter((request) => kind(request.args)).map((request) => request.args.join(' '));
}

async function autoSync(kit: CliHarness, gh: FakeGh): Promise<readonly string[]> {
  const result = await kit.run(['issue', 'sync', '--auto'], { gh });
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout;
}

const at = (kit: CliHarness): string => new Date(kit.clock.now()).toISOString();

const WRITES = [isIssueAssign, isIssueUnassign, isIssueComment, isLabelAdd, isLabelRemove, isLabelCreate, isIssueClose, isIssueBodyEdit, isIssueCreate, isLinkAdd];

/** Whether a request writes to GitHub. */
function isWrite(args: readonly string[]): boolean {
  return WRITES.some((kind) => kind(args));
}

describe('claims in the automatic sync (T3021)', () => {
  it("assigns an outside contributor's claim posted since the last pass, swaps status:open for status:claimed and replies once", async () => {
    const kit = new CliHarness(team(true));
    const free = (comments: readonly JsonRecord[]): FakeGh =>
      new FakeGh().holds(REPO, [ghIssue(REPO, 8, { title: 'Add search', authorAssociation: 'MEMBER', labels: ['status:open'], comments })]).hasLabels(REPO, ['status:open', 'status:claimed']);
    const old = commentNode(at(kit), 'NONE', 'User', { login: 'ada', body: '/take' });

    kit.clock.advance(HOUR);
    const first = free([old]);
    await autoSync(kit, first);
    assert.deepEqual(writes(first, isIssueAssign), [], 'a comment from before the first pass claims nothing');
    assert.deepEqual(parseClaims(kit.files.get(CLAIMS) ?? '').checked.get(REPO), kit.clock.now());

    kit.clock.advance(HOUR);
    const second = free([old, commentNode(at(kit), 'NONE', 'User', { login: 'bob', body: "I'll take this one" })]);
    const out = await autoSync(kit, second);
    assert.deepEqual(writes(second, isIssueAssign), [`api repos/${REPO}/issues/8/assignees -X POST -f assignees[]=bob`]);
    assert.ok(out.includes(`CLAIMED ${REPO}#8: bob took it by a comment and is assigned for ${CLAIM_DAYS} days, or until a linked pull request lands`), out.join('\n'));
    assert.ok(out.includes(`LABELED ${REPO}#8: "status:claimed"`) && out.includes(`UNLABELED ${REPO}#8: "status:open"`), out.join('\n'));
    assert.deepEqual(writes(second, isIssueComment), [`api repos/${REPO}/issues/8/comments -X POST -f body=${CLAIM_REPLY}`]);
    assert.deepEqual(
      parseClaims(kit.files.get(CLAIMS) ?? '').claims.map(({ number, login }) => ({ number, login })),
      [{ number: 8, login: 'bob' }],
    );
  });

  it('takes off an assignee its claim made once the claim ran its days with no linked pull request, and leaves one a person assigned', async () => {
    const kit = new CliHarness(team(true));
    const made = kit.clock.now() - (CLAIM_DAYS * DAY + HOUR);
    await kit.files.write(CLAIMS, formatClaims({ claims: [{ repo: REPO, number: 8, login: 'ada', at: made }, { repo: REPO, number: 9, login: 'cy', at: made }], checked: new Map([[REPO, made]]) }));
    const gh = new FakeGh()
      .holds(REPO, [
        ghIssue(REPO, 8, { title: 'Add search', authorAssociation: 'MEMBER', assignees: ['ada'], labels: ['status:claimed'] }),
        ghIssue(REPO, 9, { title: 'Fix login', authorAssociation: 'MEMBER', assignees: ['cy'], labels: ['status:claimed'], linkedPulls: 1 }),
        ghIssue(REPO, 10, { title: 'Docs', authorAssociation: 'MEMBER', assignees: ['dee'], labels: ['status:claimed'] }),
      ])
      .hasLabels(REPO, ['status:open', 'status:claimed']);
    const out = await autoSync(kit, gh);
    assert.deepEqual(writes(gh, isIssueUnassign), [`api repos/${REPO}/issues/8/assignees -X DELETE -f assignees[]=ada`]);
    assert.ok(out.includes(`RELEASED ${REPO}#8: ada's claim ran ${CLAIM_DAYS} days with no linked pull request; the assignee is taken off`), out.join('\n'));
    assert.ok(out.includes(`LABELED ${REPO}#8: "status:open"`) && out.includes(`UNLABELED ${REPO}#8: "status:claimed"`), out.join('\n'));
    assert.ok(writes(gh, isIssueComment).includes(`api repos/${REPO}/issues/8/comments -X POST -f body=${RELEASE_REPLY}`));
    assert.deepEqual(
      parseClaims(kit.files.get(CLAIMS) ?? '').claims.map(({ number, login }) => ({ number, login })),
      [{ number: 9, login: 'cy' }],
      'the claim with a linked pull request holds',
    );
  });

  it('keeps a claim whose unassign failed, to try again on the next run', async () => {
    const kit = new CliHarness(team(true));
    const made = kit.clock.now() - (CLAIM_DAYS * DAY + HOUR);
    await kit.files.write(CLAIMS, formatClaims({ claims: [{ repo: REPO, number: 8, login: 'ada', at: made }], checked: new Map([[REPO, made]]) }));
    const gh = new FakeGh()
      .holds(REPO, [ghIssue(REPO, 8, { title: 'Add search', authorAssociation: 'MEMBER', assignees: ['ada'], labels: ['status:claimed'] })])
      .hasLabels(REPO, ['status:open', 'status:claimed'])
      .failsWrite({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 502\n' });
    const result = await kit.run(['issue', 'sync', '--auto'], { gh });
    assert.ok(result.stdout.some((line) => line.startsWith(`FAILED ${REPO}#8: ending ada's claim: `) && line.endsWith('; tried again on the next run')), result.stdout.join('\n'));
    assert.deepEqual(writes(gh, isIssueComment), []);
    assert.deepEqual(parseClaims(kit.files.get(CLAIMS) ?? '').claims.map(({ login }) => login), ['ada']);
  });

  it('makes no claim and writes no claims file when the run does not push', async () => {
    const kit = new CliHarness(team(false));
    kit.clock.advance(HOUR);
    const gh = new FakeGh().holds(REPO, [ghIssue(REPO, 8, { title: 'Add search', authorAssociation: 'MEMBER', comments: [commentNode(at(kit), 'NONE', 'User', { login: 'bob', body: '/take' })] })]);
    await autoSync(kit, gh);
    assert.deepEqual(writes(gh, isIssueAssign), []);
    assert.equal(kit.files.get(CLAIMS), undefined);
  });

  it("counts its writes in the run's budget and holds a claim past it for the next run", async () => {
    const kit = new CliHarness(team(true));
    await autoSync(kit, new FakeGh().holds(REPO, []));
    kit.clock.advance(HOUR);
    const budget = autoPushWrites(300);
    const fits = Math.floor(budget / claimWrites(true));
    assert.ok(fits < CLAIMS_PER_DAY, 'the run must hold fewer claims than a day allows');
    const posted = at(kit);
    const free = (assigned: number): FakeGh =>
      new FakeGh()
        .holds(
          REPO,
          Array.from({ length: fits + 1 }, (_, index) =>
            ghIssue(REPO, index + 1, {
              title: `Issue ${String(index + 1)}`,
              authorAssociation: 'MEMBER',
              labels: [index < assigned ? 'status:claimed' : 'status:open'],
              assignees: index < assigned ? [`user${String(index)}`] : [],
              comments: [commentNode(posted, 'NONE', 'User', { login: `user${String(index)}`, body: '/take' })],
            }),
          ),
        )
        .hasLabels(REPO, ['status:open', 'status:claimed']);

    const first = free(0);
    const out = await autoSync(kit, first);
    assert.equal(writes(first, isIssueAssign).length, fits);
    assert.ok(out.includes(`HELD ${REPO}#${String(fits + 1)}: user${String(fits)}'s claim waits for the next run, as this run's ${String(budget)} write(s) are spent`), out.join('\n'));
    assert.ok(writes(first, isWrite).length <= budget, writes(first, isWrite).join('\n'));

    kit.clock.advance(HOUR);
    const second = free(fits);
    await autoSync(kit, second);
    assert.deepEqual(writes(second, isIssueAssign), [`api repos/${REPO}/issues/${String(fits + 1)}/assignees -X POST -f assignees[]=user${String(fits)}`]);
  });

  it('makes no claim on an outsider issue no one accepted', async () => {
    const kit = new CliHarness(team(true));
    await autoSync(kit, new FakeGh().holds(REPO, []));
    kit.clock.advance(HOUR);
    const gh = new FakeGh().holds(REPO, [ghIssue(REPO, 8, { title: 'Add search', authorAssociation: 'NONE', comments: [commentNode(at(kit), 'NONE', 'User', { login: 'bob', body: '/take' })] })]);
    await autoSync(kit, gh);
    assert.deepEqual(writes(gh, isIssueAssign), []);
    assert.deepEqual(parseClaims(kit.files.get(CLAIMS) ?? '').claims, []);
  });

  it(`reads the comments of at most ${String(CLAIM_READS)} issues a run, and those left on the next run`, async () => {
    const kit = new CliHarness(team(true));
    await autoSync(kit, new FakeGh().holds(REPO, []));
    kit.clock.advance(HOUR);
    const plain = new Date(kit.clock.now() - 2 * 60_000).toISOString();
    const takes = new Date(kit.clock.now() - 60_000).toISOString();
    const issues = Array.from({ length: CLAIM_READS + 2 }, (_, index) =>
      ghIssue(REPO, index + 1, {
        title: `Issue ${String(index + 1)}`,
        authorAssociation: 'MEMBER',
        comments: [index < CLAIM_READS ? commentNode(plain, 'NONE', 'User', { login: `user${String(index)}`, body: 'Nice idea.' }) : commentNode(takes, 'NONE', 'User', { login: `user${String(index)}`, body: '/take' })],
      }),
    );

    const first = new FakeGh().holds(REPO, issues);
    const out = await autoSync(kit, first);
    assert.equal(writes(first, isCommentsRead).length, CLAIM_READS);
    assert.deepEqual(writes(first, isIssueAssign), []);
    assert.ok(out.includes(`HELD ${REPO}: 2 issue(s) with new comments wait for the next run, as a run reads at most ${String(CLAIM_READS)} for claims`), out.join('\n'));

    kit.clock.advance(HOUR);
    const second = new FakeGh().holds(REPO, issues);
    await autoSync(kit, second);
    assert.deepEqual(writes(second, isCommentsRead), [CLAIM_READS + 1, CLAIM_READS + 2].map((number) => `api repos/${REPO}/issues/${String(number)}/comments -X GET -f since=${takes} -f per_page=30`));
    assert.equal(writes(second, isIssueAssign).length, 2);
  });

  it('reads again on the next run the comments of an issue whose read failed', async () => {
    const kit = new CliHarness(team(true));
    await autoSync(kit, new FakeGh().holds(REPO, []));
    kit.clock.advance(HOUR);
    const issues = [ghIssue(REPO, 7, { title: 'Add search', authorAssociation: 'MEMBER', comments: [commentNode(at(kit), 'NONE', 'User', { login: 'bob', body: '/take' })] })];
    const first = new FakeGh().holds(REPO, issues).answersCommentsRead({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: HTTP 502\n' });
    const out = await autoSync(kit, first);
    assert.deepEqual(writes(first, isIssueAssign), []);
    assert.ok(
      out.some((line) => line.startsWith(`FAILED ${REPO}#7: reading its new comments for a claim: `) && line.endsWith('; read again on the next run')),
      out.join('\n'),
    );

    kit.clock.advance(HOUR);
    const second = new FakeGh().holds(REPO, issues);
    await autoSync(kit, second);
    assert.deepEqual(writes(second, isIssueAssign), [`api repos/${REPO}/issues/7/assignees -X POST -f assignees[]=bob`]);
  });
});
