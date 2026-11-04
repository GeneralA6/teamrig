import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatSnapshot } from '../budget/snapshot.ts';
import { KIT_VERSION } from '../core/version.ts';
import type { CommitStat } from '../push-guard/commit-size.ts';
import { passRecordPath } from '../push-guard/pass-record.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { FakeMergeGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-merge-git.ts';
import { FakeStarterWatch } from '../testing/fake-starter-watch.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { heldBy, otherRuns } from '../testing/held-lock.ts';
import { EXIT } from './runtime.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const MINUTE = 60_000;
const SESSION_ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const DEPLOYING = { ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-api'] } } } };
const MERGE_RUN = ['merge', '--session', 'alpha'];
/** A run in the worktree, outside the project folder: its team comes from $TEAMRIG_TEAM. */
const IN_WORKTREE = { cwd: WORKTREE, env: { TEAMRIG_TEAM: 'app' } };

interface World {
  readonly kit: CliHarness;
  readonly git: FakeMergeGit;
  readonly steps: FakeSteps;
}

/** A team whose push takes 2 minutes and lands, as git push does when origin takes it. */
function world(config: Readonly<Record<string, unknown>> = DEPLOYING): World {
  const kit = new CliHarness(config);
  const git = new FakeMergeGit();
  const steps = new FakeSteps(kit.clock).ends(0, 2 * MINUTE).whileRunning(async (request) => {
    git.pushed('main', git.heads.get(request.cwd) ?? '');
  });
  return { kit, git, steps };
}

function ledgerOf(kit: CliHarness): unknown[] {
  return (kit.files.get(LEDGER) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('teamrig merge', () => {
  it('merges the branch of the current folder, records the push and the deploy it starts, and prints DONE', async () => {
    const { kit, git, steps } = world();
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.deepEqual(result, {
      code: 0,
      stdout: [
        '2030-01-08 10:00:00 UTC pushing feat (rebased) to main; the pre-push hook runs now',
        '2030-01-08 10:02:00 UTC deleted feat on origin',
        '2030-01-08 10:02:00 UTC deleted the local feat',
        `2030-01-08 10:02:00 UTC next: teamrig worktree remove "${WORKTREE}"`,
        'DONE pushed rebased to main; cloud-api deploy on push',
      ],
      stderr: [],
    });
    assert.equal(steps.ran[0]?.cwd, WORKTREE);
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'merge app: push feat to main', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [
      start,
      { ...start, endedAt: '2030-01-08T10:02:00.000Z', exitCode: 0 },
      {
        type: 'deploy',
        kind: 'deploy',
        session: 'alpha',
        repo: 'app',
        range: 'rebased',
        what: 'merge feat',
        note: 'pushed to main; cloud-api deploy on push, not watched by teamrig',
        startedAt: '2030-01-08T10:00:00.000Z',
        rolledAt: '2030-01-08T10:02:00.000Z',
      },
    ]);
  });

  it('keeps the branch on origin and here with --keep-remote and --no-delete-local', async () => {
    const { kit, git, steps } = world();
    const result = await kit.run([...MERGE_RUN, '--keep-remote', '--no-delete-local'], { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(result.code, 0);
    assert.ok(!git.log.some((line) => line.startsWith('deleteRemoteBranch') || line.startsWith('detach')));
    assert.equal(result.stdout.at(-2), `2030-01-08 10:02:00 UTC next: teamrig worktree remove "${WORKTREE}" --delete-branch`);
  });

  it('prints FAILED and exits 1 when the push does not merge the branch', async () => {
    const { kit, git, steps } = world();
    steps.ends(1).whileRunning(async () => undefined);
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), "FAILED the push exited 1; origin's main is at base, not at rebased");
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
  });

  it('kills the push once the shell that started it ended, records exit 129, frees the lock and pushes no more', async () => {
    const { kit, git, steps } = world();
    const starters = new FakeStarterWatch();
    steps.whileRunning(async () => {
      git.pushed('main', 'moved');
      starters.end();
    });
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps, starters });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, "FAILED the push was killed when its launching shell ended (exit 129); origin's main is at moved, not at rebased"]);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'merge app: push feat to main', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:00:00.000Z', exitCode: 129 }]);
    assert.deepEqual([steps.ran.length, kit.files.get(LOCK), starters.openWatches], [1, undefined, 0]);
  });

  it('stops waiting for the host lock once the shell that started it ended, pushing nothing and leaving the lock to its holder', async () => {
    const { kit, git, steps } = world();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch();
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end();
    };
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps, starters, sleep, sessionProcesses: otherRuns() });
    assert.equal(result.code, 1);
    assert.equal(result.stdout.at(-1), 'STOPPED before the host lock was free: nothing ran');
    assert.equal(result.stdout.at(-2), '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: no one waits for it any more');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER), starters.openWatches], [[], heldBy(), undefined, 0]);
  });

  it('prints WAITING with the merge command’s last line and exits 75 when the command waits, pushing nothing', async () => {
    const MERGE = ['node', 'merge.ts'];
    const { kit, git, steps } = world({ ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, merge: { command: MERGE } } } } });
    const hooks = new FakeHooks(kit.clock).answer(MERGE, { end: 75, lines: ['https://forge/pr/7'] });
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps, hooks });
    assert.equal(result.code, 75);
    assert.equal(result.stdout.at(-2), `2030-01-08 10:00:00 UTC next: run teamrig merge again in ${WORKTREE} once feat is merged`);
    assert.equal(result.stdout.at(-1), 'WAITING https://forge/pr/7');
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
    assert.ok(kit.files.get(join(TEAM_HOME, 'state', 'deploys', 'pending-merges', 'app%2Ffeat.json'))?.includes('"note": "https://forge/pr/7"'));
  });

  it('refuses a folder outside git', async () => {
    const { kit, git, steps } = world();
    assert.deepEqual(await kit.run(MERGE_RUN, { cwd: APP, mergeGit: git, steps }), { code: 2, stdout: [`REFUSED ${APP} is not in a git checkout`], stderr: [] });
  });

  it('refuses in the blackout before the reset the status line last reported', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, budget: { statusSnapshotDir: 'live' }, delivery: { ...DEPLOYING.delivery, schedule: { resetBlackoutHours: 4 } } });
    const snapshot = formatSnapshot({
      ts: '2030-01-08T09:55:00.000Z',
      sessionId: SESSION_ID,
      cwd: APP,
      agentName: null,
      model: null,
      rateLimits: { fiveHour: null, sevenDay: { usedPct: 90, resetsAt: Date.parse('2030-01-08T12:00:00Z') } },
      rateLimitsSince: null,
      rateLimitsAfter: null,
      costUsd: null,
      contextUsedPct: null,
      contextInputTokens: null,
    });
    await kit.files.write(join(TEAM_HOME, 'live', `${SESSION_ID}.json`), snapshot);
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.deepEqual(result.stdout, ['REFUSED deploy blackout before the weekly token reset: no deploy from Tue 01-08 08:00 UTC until Tue 01-08 12:00 UTC (reset from the status line)']);
    assert.deepEqual(steps.ran, []);
  });

  it('merges in a blackout window when neither the status line nor budget.reset names the reset', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, delivery: { ...DEPLOYING.delivery, schedule: { resetBlackoutHours: 24 } } });
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(result.code, 0);
  });

  it('takes the reset from budget.reset when no status line reported one', async () => {
    const { kit, git, steps } = world({ ...DEPLOYING, budget: { reset: { weekday: 'tue', timeUtc: '11:00' } }, delivery: { ...DEPLOYING.delivery, schedule: { resetBlackoutHours: 2 } } });
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.deepEqual(result.stdout, ['REFUSED deploy blackout before the weekly token reset: no deploy from Tue 01-08 09:00 UTC until Tue 01-08 11:00 UTC (reset from the budget.reset config)']);
  });

  it('refuses teamrig integrate, its old name, with the new one and exit 64, merging nothing', async () => {
    const { kit, git, steps } = world();
    const result = await kit.run(['integrate', '--session', 'alpha'], { ...IN_WORKTREE, mergeGit: git, steps });
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'integrate was renamed: use merge']);
    assert.deepEqual([steps.ran, git.log, kit.files.get(LEDGER)], [[], [], undefined]);
  });
});

describe('teamrig merge with the review gate', () => {
  const GATED = {
    ...TEAM,
    roles: { lead: 'lead', securityReviewer: 'bravo' },
    delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, reviewGate: true } } },
  };

  it("holds a lockfile change of alpha's task for the security reviewer, then merges it once the reviewer approved", async () => {
    const { kit, git, steps } = world(GATED);
    git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't1-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    git.paths = ['package-lock.json'];
    const added = await kit.run(['add', '--title', 'Pin the lockfile', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));

    const held = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(held.code, EXIT.refused, held.stderr.join('\n'));
    assert.match(held.stdout.at(-1) ?? '', /^REFUSED review hold H\w+ keeps t1-feat \(base\.\.rebased\) off the default branch: it changes package-lock\.json\. .*--waits approval:bravo /);
    assert.deepEqual(steps.ran, []);

    kit.clock.advance(MINUTE);
    const asked = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:bravo', '--note', 'review hold of t1-feat', '--session', 'alpha']);
    assert.equal(asked.code, EXIT.ok, asked.stderr.join('\n'));
    const approved = await kit.run(['approve', 'T1', '--note', 'the pin resolves as audited', '--session', 'bravo']);
    assert.equal(approved.code, EXIT.ok, approved.stderr.join('\n'));
    kit.clock.advance(MINUTE);

    const merged = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(merged.code, EXIT.ok, merged.stdout.join('\n'));
    assert.equal(steps.ran.length, 1);
  });
});

describe('teamrig merge with the decision record gate (T1869)', () => {
  const RECORDED = { ...TEAM, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], decisionRecordGate: true } } } };
  const RECORD = 'docs/decisions/2030-01-08-feature.md';

  it("refuses alpha's task branch while its task folder holds a design note and the branch adds no record, then merges it once one is committed", async () => {
    const { kit, git, steps } = world(RECORDED);
    git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't1-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    await kit.files.write(join(TEAM_HOME, 'tasks', 'T1', 'design.md'), '# T1 design\n');

    const held = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(held.code, EXIT.refused, held.stderr.join('\n'));
    assert.match(held.stdout.at(-1) ?? '', /^REFUSED T1 has a design note \(design\.md\) and t1-feat adds or changes no decision record in docs\/decisions\//);
    assert.deepEqual(steps.ran, []);

    git.paths = ['src/app.ts', RECORD];
    git.files.set(`mine:${RECORD}`, '# Feature\n');
    const merged = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps });
    assert.equal(merged.code, EXIT.ok, merged.stdout.join('\n'));
    assert.equal(steps.ran.length, 1);
  });
});

describe('teamrig merge under pushToProtected gated (T858)', () => {
  const GATED = { ...TEAM, pushGuard: { pushToProtected: 'gated' }, delivery: { repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: [], reviewGate: true } } } };
  const DEPLOYS = join(TEAM_HOME, 'state', 'deploys');
  const COMMITS: readonly CommitStat[] = [{ sha: 'rebased', subject: 'Add the feature', body: '', files: [{ path: 'src/app.ts', added: 4, deleted: 1 }, { path: 'src/app.test.ts', added: 9, deleted: 0 }] }];

  /** alpha's task T1, whose branch t1-feat is checked out in the worktree. */
  async function gatedWorld(): Promise<World> {
    const made = world(GATED);
    made.git.checkouts.set(WORKTREE, { top: WORKTREE, branch: 't1-feat', mainCheckout: MAIN_CHECKOUT, linked: true });
    await made.kit.run(['add', '--title', 'Ship the feature', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    return made;
  }

  it('merges a change that holds every gate with no approval and logs it in merges.jsonl', async () => {
    const { kit, git, steps } = await gatedWorld();
    const pass = { tree: 'tree-rebased', commit: 'rebased', checks: ['unit'], passedAt: '2030-01-08T09:30:00.000Z', node: 'v24.0.0' };
    await kit.files.write(passRecordPath(WORKTREE, `${MAIN_CHECKOUT}/.git`, pass.tree), JSON.stringify(pass));
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps, commitLog: { between: () => COMMITS } });
    assert.equal(result.code, 0, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('2030-01-08 10:00:00 UTC self-merge gates of t1-feat: every gate holds, so it merges with no approval'), result.stdout.join('\n'));
    const [row, ...more] = (kit.files.get(join(DEPLOYS, 'merges.jsonl')) ?? '').split('\n').filter((line) => line !== '');
    assert.deepEqual(more, []);
    assert.match(row ?? '', /"session":"alpha","repo":"app","branch":"t1-feat","task":"T1","base":"base","head":"rebased","tree":"tree-rebased","files":2,"lines":14,"checks":\["unit"\],"review":"untouched","route":"self"\}$/);
  });

  it('holds a change with no pass record for the lead and pushes nothing', async () => {
    const { kit, git, steps } = await gatedWorld();
    const result = await kit.run(MERGE_RUN, { ...IN_WORKTREE, mergeGit: git, steps, commitLog: { between: () => COMMITS } });
    assert.equal(result.code, 2);
    assert.match(result.stdout.at(-1) ?? '', /^REFUSED gate hold G\w+ keeps t1-feat \(base\.\.rebased\) off the default branch: pass: .* --waits approval:lead /);
    assert.match(kit.files.get(join(DEPLOYS, 'gate-holds', 'app~t1-feat.json')) ?? '', /"task":\s*"T1",\s*"session":\s*"alpha",\s*"reviewer":\s*"lead"/);
    assert.deepEqual([steps.ran, kit.files.get(join(DEPLOYS, 'merges.jsonl'))], [[], undefined]);
  });
});
