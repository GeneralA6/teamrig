import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
import { FakeMergeGit, MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { EXIT } from './runtime.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** T1 owned by alpha and T2 by bravo, both overdue two days later, and a line from bravo in alpha's inbox. */
async function overdueTeam(): Promise<CliHarness> {
  const kit = new CliHarness();
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-08', '--session', 'alpha']);
  await kit.run(['add', '--title', 'Ship the docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'bravo', '--due', '2030-01-08', '--session', 'alpha']);
  kit.clock.advance(2 * DAY_MS);
  await kit.run(['inbox', 'add', '--to', 'alpha', '--text', 'the docs moved to the wiki', '--session', 'bravo']);
  return kit;
}

function checkPart(stdout: readonly string[]): string[] {
  const from = stdout.findIndex((line) => line.startsWith('CHECK '));
  return stdout.slice(from, -1);
}

describe('runCli: start prints the start of a work block in one call', () => {
  it("gives a session the time, its inbox marked read, its own tasks and flags, then the week's use", async () => {
    const kit = await overdueTeam();
    const started = await kit.run(['start', '--session', 'alpha']);
    assert.equal(started.code, EXIT.ok, started.stdout.join('\n'));
    const { stdout } = started;
    assert.equal(stdout[0], 'START alpha, Thu 01-10 10:00 UTC');
    assert.equal((await kit.run(['start', '--session', 'alpha'], { timeZone: 'Asia/Jerusalem' })).stdout[0], 'START alpha, Thu 01-10 12:00 IST', "on the team's clock");
    assert.match(stdout[1] ?? '', /bravo: the docs moved to the wiki$/);
    assert.match(stdout[2] ?? '', /^READ alpha: 1 new line, shown above/);
    assert.match(stdout[3] ?? '', /^LIST 1 task\(s\)/);
    assert.match(checkPart(stdout)[0] ?? '', /^CHECK [1-9]\d* flag\(s\), alpha's tasks and skills, /);
    assert.ok(checkPart(stdout).some((line) => /\bT1\b/.test(line)), checkPart(stdout).join('\n'));
    assert.ok(!stdout.some((line) => /\bT2\b/.test(line)), stdout.join('\n'));
    assert.match(stdout.at(-1) ?? '', /^Week: /);

    const again = await kit.run(['inbox', 'read', '--session', 'alpha']);
    assert.match(again.stdout[0] ?? '', /^READ alpha: nothing new/);
  });

  it('prints every task field and every flag in full with --all, as the short forms offer', async () => {
    const kit = await overdueTeam();
    const short = await kit.run(['start', '--session', 'alpha']);
    assert.ok(short.stdout.some((line) => line.includes('--all for every')));
    const full = await kit.run(['start', '--session', 'alpha', '--all']);
    assert.equal(full.code, EXIT.ok, full.stdout.join('\n'));
    assert.ok(!full.stdout.some((line) => line.includes('--all for every')), full.stdout.join('\n'));
    assert.ok(full.stdout.some((line) => /\bT1\b/.test(line)) && !full.stdout.some((line) => /\bT2\b/.test(line)), full.stdout.join('\n'));
  });

  it("ends the lead's start with the account's resets in stock, and no other session's (T2450)", async () => {
    const resets = [{ kind: 'fable', count: 3, expiresUtc: '2030-03-01 08:00', usedUtc: ['2030-01-02 09:00'] }];
    const kit = new CliHarness({ ...TEAM, budget: { resets } });
    const lead = await kit.run(['start', '--session', 'lead']);
    assert.equal(lead.code, EXIT.ok, lead.stdout.join('\n'));
    assert.match(lead.stdout.at(-2) ?? '', /^Week: /);
    assert.equal(lead.stdout.at(-1), 'Resets in stock: fable 2 left, the next expiring 2030-03-01 08:00 UTC (in 51 days).');
    assert.match((await kit.run(['start', '--session', 'alpha'])).stdout.at(-1) ?? '', /^Week: /);
  });

  it("gives the lead every task's flags", async () => {
    const kit = await overdueTeam();
    const started = await kit.run(['start', '--session', 'lead']);
    assert.equal(started.code, EXIT.ok, started.stdout.join('\n'));
    const check = checkPart(started.stdout);
    assert.doesNotMatch(check[0] ?? '', /tasks and skills/);
    assert.ok(check.some((line) => /\bT1\b/.test(line)) && check.some((line) => /\bT2\b/.test(line)), check.join('\n'));
  });

  it('raises UNTRIAGED for a leader, the lead or a sub-lead, never for the owner of the task', async () => {
    const kit = await overdueTeam();
    await kit.run(['add', '--title', 'Tidy the docs', '--description', 'what and why', '--priority', 'p2', '--session', 'bravo']);
    const untriagedIn = async (session: string): Promise<string[]> => {
      const { stdout } = await kit.run(['start', '--session', session, '--all']);
      return checkPart(stdout).flatMap((line) => /^UNTRIAGED .*--class <name>\)\) (T\d+)/.exec(line)?.[1] ?? []);
    };
    assert.deepEqual(await untriagedIn('lead'), ['T1', 'T2', 'T3']);
    assert.deepEqual(await untriagedIn('alpha'), []);
    assert.deepEqual(await untriagedIn('bravo'), []);
    assert.equal((await kit.run(['promote', 'alpha', '--members', 'bravo', '--session', 'lead', '--yes'])).code, EXIT.ok);
    assert.deepEqual(await untriagedIn('alpha'), ['T3'], "bravo's own add, and T2 reads as triaged now that alpha leads bravo");
  });

  it("gives a sub-lead its group's task flags, and lets it reorder that work but not hand it out of the group (T782)", async () => {
    const kit = await overdueTeam();
    assert.equal((await kit.run(['promote', 'alpha', '--members', 'bravo', '--session', 'lead', '--yes'])).code, EXIT.ok);
    const check = checkPart((await kit.run(['start', '--session', 'alpha'])).stdout);
    assert.match(check[0] ?? '', /^CHECK [1-9]\d* flag\(s\), alpha's tasks and skills, its group's tasks \(bravo\), /);
    assert.ok(check.some((line) => /\bT1\b/.test(line)) && check.some((line) => /\bT2\b/.test(line)), check.join('\n'));
    const reordered = await kit.run(['update', 'T2', '--priority', 'p1', '--due', '2030-01-12', '--session', 'alpha']);
    assert.equal(reordered.code, EXIT.ok, reordered.stderr.join('\n'));
    const handed = await kit.run(['update', 'T2', '--owner', 'lead', '--session', 'alpha']);
    assert.notEqual(handed.code, EXIT.ok);
    assert.match([...handed.stdout, ...handed.stderr].join('\n'), /REFUSED alpha hands T2 only to itself or a session it leads \(bravo\)/);
  });

  it("says how far the checkout it runs in is behind origin's main as last fetched, only when it is (T1006)", async () => {
    const kit = await overdueTeam();
    const git = new FakeMergeGit();
    git.checkouts.set(APP, { top: APP, branch: 'feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    git.heads.set(APP, 'mine');
    git.tracking.set('origin/main', 'newer');
    git.landed = ['one', 'two'];
    const behind = await kit.run(['start', '--session', 'alpha'], { mergeGit: git });
    assert.equal(behind.code, EXIT.ok, behind.stdout.join('\n'));
    assert.deepEqual(behind.stdout.slice(0, 2), ['START alpha, Thu 01-10 10:00 UTC', 'BEHIND feat is 2 commit(s) behind origin/main as last fetched: rebase before you edit']);
    assert.deepEqual(git.log, [], 'it never fetches');

    git.heads.set(APP, 'newer');
    const current = await kit.run(['start', '--session', 'alpha'], { mergeGit: git });
    assert.ok(!current.stdout.some((line) => line.startsWith('BEHIND')), current.stdout.join('\n'));
  });

  it('needs to know the caller', async () => {
    const kit = new CliHarness();
    const bare = await kit.run(['start']);
    assert.equal(bare.code, EXIT.usage);
    assert.match(bare.stderr.join('\n'), /--session \(or \$TEAMRIG_SESSION\) is required/);
  });
});
