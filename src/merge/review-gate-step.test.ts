import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import { TimeZone } from '../core/zone.ts';
import type { CheckOutcome } from '../push-guard/review-gate.ts';
import type { ApprovalVerdict } from '../register/events.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeMergeGit, WORKTREE } from '../testing/fake-merge-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { isReviewClearance, REVIEW_CLEARANCES, reviewGateVerdict, taskOfBranch, type GatedChange, type GateTask, type ReviewGateSetup, type ReviewVerdict } from './review-gate-step.ts';
import { ReviewHolds, type ReviewHold } from './review-holds.ts';

const MINUTE_MS = 60_000;
const CHECK = ['node', 'review.js'];
const SETUP: ReviewGateSetup = {
  reviewPaths: [
    { glob: 'src/auth/**', mode: 'check', class: 'security' },
    { glob: 'docs/**', mode: 'always', class: 'leader' },
  ],
  tree: new LeadTree(testConfig()),
  roles: { securityReviewer: 'bravo' },
};
const CHANGE: GatedChange = { session: 'alpha', repo: 'app', config: { reviewGate: true }, top: WORKTREE, branch: 't9-gate', base: 'base', head: 'rebased' };

/** The gate over a fake checkout, a hold folder in memory, a register of tasks and a review check that answers `outcome`. */
class Gate {
  readonly git = new FakeMergeGit();
  readonly holds = new ReviewHolds(new MemoryFiles(), '/team/deploys/review-holds');
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');
  readonly tasks = new Map<string, GateTask>([['T9', { owner: 'alpha', answer: null }]]);
  /** Each check run, as `<argv> @ <base>`. */
  readonly checks: string[] = [];
  readonly said: string[] = [];
  outcome: CheckOutcome = { kind: 'clean' };

  constructor(paths: readonly string[] | undefined) {
    this.git.paths = paths;
  }

  /** Why the gate holds the change; undefined when it lets it go. */
  async run(change: Partial<GatedChange> = {}, setup: ReviewGateSetup = SETUP): Promise<string | undefined> {
    const verdict = await this.verdict(change, setup);
    return verdict.kind === 'held' ? verdict.reason : undefined;
  }

  verdict(change: Partial<GatedChange> = {}, setup: ReviewGateSetup = SETUP): Promise<ReviewVerdict> {
    return reviewGateVerdict(
      setup,
      TimeZone.UTC,
      {
        git: this.git,
        holds: this.holds,
        clock: this.clock,
        taskOf: async (id) => this.tasks.get(id),
        runCheck: async (argv, base) => {
          this.checks.push(`${argv.join(' ')} @ ${base}`);
          return this.outcome;
        },
        say: (text) => this.said.push(text),
      },
      { ...CHANGE, ...change },
    );
  }

  /** T9's approval wait is answered now. */
  answer(verdict: ApprovalVerdict, by: string, note: string | null = null): void {
    this.tasks.set('T9', { owner: 'alpha', answer: { verdict, by, at: new Date(this.clock.now()).toISOString(), note } });
  }

  async hold(): Promise<ReviewHold> {
    const hold = await this.holds.read(CHANGE.repo, CHANGE.branch);
    assert.ok(hold !== undefined, 'a hold was made');
    return hold;
  }

  /** The commit `to` holds each of `paths` as `from` does, as a rebase that left them alone. */
  keepFiles(from: string, to: string, paths: readonly string[]): void {
    for (const path of paths) {
      this.git.blobs.set(`${to}:${path}`, `blob-${from}:${path}`);
    }
  }
}

describe('taskOfBranch', () => {
  it('reads the task a branch is named after, after any folder part', () => {
    assert.equal(taskOfBranch('t828-self-merge-gate'), 'T828');
    assert.equal(taskOfBranch('feature/t9-gate'), 'T9');
    for (const branch of ['gate', 'at9-gate', 't0-gate', 't9']) {
      assert.equal(taskOfBranch(branch), undefined, branch);
    }
  });
});

describe('isReviewClearance', () => {
  it('knows each way the gate lets a change go, and nothing else', () => {
    assert.ok(REVIEW_CLEARANCES.every(isReviewClearance));
    for (const value of ['clean', 'Approved', '', null, undefined, 1]) {
      assert.equal(isReviewClearance(value), false, String(value));
    }
  });
});

describe('reviewGateVerdict: what it holds', () => {
  it('lets every change go where the repo has no review gate, reading nothing', async () => {
    assert.deepEqual(await new Gate(undefined).verdict({ config: { reviewGate: false } }), { kind: 'clear', review: 'off' });
  });

  it('lets a change go that hits no review path, holding nothing', async () => {
    const gate = new Gate(['src/app.ts', 'docsy.md']);
    assert.deepEqual(await gate.verdict(), { kind: 'clear', review: 'untouched' });
    assert.equal(await gate.holds.read(CHANGE.repo, CHANGE.branch), undefined);
  });

  it('holds a lockfile change for the security reviewer, the lead its fallback, and says how to ask them', async () => {
    const gate = new Gate(['package-lock.json', 'src/app.ts']);
    const refusal = await gate.run();
    const hold = await gate.hold();
    assert.match(hold.id, /^H[0-9a-f]{12}$/);
    assert.deepEqual(
      { ...hold, id: 'H' },
      {
        repo: 'app',
        branch: 't9-gate',
        base: 'base',
        head: 'rebased',
        session: 'alpha',
        id: 'H',
        tree: 'tree-rebased',
        task: 'T9',
        holdClass: 'security',
        reviewer: { who: 'bravo', fallback: 'lead' },
        hits: [{ path: 'package-lock.json', glob: 'package-lock.json' }],
        findings: undefined,
        createdAt: '2030-01-08T10:00:00.000Z',
      },
    );
    assert.equal(
      refusal,
      `review hold ${hold.id} keeps t9-gate (base..rebased) off the default branch: it changes package-lock.json. bravo answers it, and lead too from ` +
        `${TimeZone.UTC.minute(new Date('2030-01-08T10:30:00Z'))}: teamrig set T9 --status waiting --waits approval:bravo --note "review hold ${hold.id} of t9-gate ` +
        'base..rebased" --session alpha; merge again once it is approved',
    );
    assert.deepEqual(gate.checks, []);
  });

  it('holds a leader path for the lead, with no fallback', async () => {
    const gate = new Gate(['docs/guide.md']);
    assert.match((await gate.run()) ?? '', /it changes docs\/guide\.md \(docs\/\*\*\)\. lead answers it: .*--waits approval:lead /);
    assert.deepEqual((await gate.hold()).reviewer, { who: 'lead', fallback: undefined });
  });

  it('names five held paths, then how many more', async () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `docs/${name}.md`);
    assert.match((await new Gate(paths).run()) ?? '', /docs\/e\.md \(docs\/\*\*\), 2 more\./);
  });
});

describe('reviewGateVerdict: the review check', () => {
  const checked = { config: { reviewGate: true, reviewCheck: CHECK } };

  it("clears a check path the review check passes, running it against the change's base", async () => {
    const gate = new Gate(['src/auth/login.ts']);
    assert.deepEqual(await gate.verdict(checked), { kind: 'clear', review: 'checked' });
    assert.deepEqual(gate.checks, ['node review.js @ base']);
    assert.equal(await gate.holds.read(CHANGE.repo, CHANGE.branch), undefined);
    assert.ok(gate.said.includes('review check of t9-gate: clean'));
  });

  it('holds a flagged check path for its class with the findings, and a broken check for that class too', async () => {
    const flagged = new Gate(['src/auth/login.ts']);
    flagged.outcome = { kind: 'flagged', findings: 'token in login.ts' };
    assert.match((await flagged.run(checked)) ?? '', /the review check flagged it \(its findings are above\)\. bravo answers it/);
    const hold = await flagged.hold();
    assert.deepEqual([hold.holdClass, hold.reviewer.who, hold.findings], ['security', 'bravo', 'token in login.ts']);
    const broken = new Gate(['src/auth/login.ts']);
    broken.outcome = { kind: 'broken', detail: 'exited 1', exitCode: 1 };
    assert.match((await broken.run(checked)) ?? '', /the review check exited 1, which is no pass\. bravo answers it/);
    assert.deepEqual([(await broken.hold()).holdClass, (await broken.hold()).findings], ['security', undefined]);
  });

  it('holds a check path for its class where the repo sets no review check, running none', async () => {
    const gate = new Gate(['src/auth/login.ts']);
    assert.match((await gate.run()) ?? '', /no reviewCheck is set to clear its check paths\. bravo answers it/);
    assert.deepEqual(gate.checks, []);
  });

  it('runs no check where a path needs security review anyway', async () => {
    const gate = new Gate(['src/auth/login.ts', 'package-lock.json']);
    await gate.run(checked);
    assert.deepEqual(gate.checks, []);
    assert.equal((await gate.hold()).holdClass, 'security');
  });
});

describe('reviewGateVerdict: answering a hold', () => {
  it('lands the same change once its reviewer approves it after the hold, not on an approval from before', async () => {
    const gate = new Gate(['package-lock.json']);
    gate.answer('approved', 'bravo');
    gate.clock.advance(MINUTE_MS);
    await gate.run();
    assert.match((await gate.run()) ?? '', /^review hold H\w+ keeps t9-gate/);
    gate.clock.advance(5 * MINUTE_MS);
    gate.answer('approved', 'bravo');
    assert.deepEqual(await gate.verdict(), { kind: 'clear', review: 'approved' });
    assert.ok(gate.said.some((line) => /^review hold H\w+ of t9-gate: bravo approved it$/.test(line)));
  });

  it('counts the fallback leader only from 30 minutes on, and asks them by then', async () => {
    const gate = new Gate(['package-lock.json']);
    await gate.run();
    gate.clock.advance(10 * MINUTE_MS);
    gate.answer('approved', 'lead');
    assert.match((await gate.run()) ?? '', /--waits approval:bravo /);
    gate.clock.advance(21 * MINUTE_MS);
    assert.match((await gate.run()) ?? '', /--waits approval:lead /, 'the early answer does not count, and the lead is asked now');
    gate.answer('approved', 'lead');
    assert.equal(await gate.run(), undefined);
  });

  it('says who declined it and why', async () => {
    const gate = new Gate(['package-lock.json']);
    await gate.run();
    gate.clock.advance(MINUTE_MS);
    gate.answer('declined', 'bravo', 'pins a\nnew dev dep');
    assert.match((await gate.run()) ?? '', /^review hold H\w+: bravo declined T9 \(pins a new dev dep\); change t9-gate, then merge again for a new hold$/);
  });

  it('makes a new hold when the branch moved on, as its old one bound other commits', async () => {
    const gate = new Gate(['package-lock.json']);
    await gate.run();
    const first = await gate.hold();
    gate.clock.advance(MINUTE_MS);
    gate.answer('approved', 'bravo');
    gate.clock.advance(MINUTE_MS);
    assert.match((await gate.run({ head: 'rebased2' })) ?? '', /^review hold H\w+ keeps t9-gate \(base\.\.rebased2\)/);
    const second = await gate.hold();
    assert.notEqual(second.id, first.id);
    assert.equal(second.tree, 'tree-rebased2');
    assert.ok(second.createdAt > first.createdAt);
  });
});

describe('reviewGateVerdict: carrying an approval to a rebased change', () => {
  const HELD = ['package-lock.json', 'src/auth/old.ts'];
  const MOVED: Partial<GatedChange> = { base: 'base2', head: 'rebased2' };
  const CHECKED: Partial<GatedChange> = { config: { reviewGate: true, reviewCheck: CHECK } };

  /** A gate whose change bravo approved, then rebased from `base` onto `base2` as `rebased2`, leaving `paths` alone. */
  async function approvedAndRebased(paths: readonly string[] = HELD, change: Partial<GatedChange> = {}, outcome?: CheckOutcome): Promise<{ gate: Gate; first: ReviewHold }> {
    const gate = new Gate(paths);
    gate.outcome = outcome ?? gate.outcome;
    await gate.run(change);
    const first = await gate.hold();
    gate.clock.advance(MINUTE_MS);
    gate.answer('approved', 'bravo');
    gate.clock.advance(MINUTE_MS);
    gate.keepFiles('base', 'base2', paths);
    gate.keepFiles('rebased', 'rebased2', paths);
    return { gate, first };
  }

  it('lands the rebased change on its approved hold when each held file is the same at both ends, a deleted one too', async () => {
    const { gate, first } = await approvedAndRebased();
    for (const head of ['rebased', 'rebased2']) {
      gate.git.blobs.set(`${head}:src/auth/old.ts`, undefined);
    }
    assert.deepEqual(await gate.verdict(MOVED), { kind: 'clear', review: 'approved' });
    assert.ok(gate.said.includes(`review hold ${first.id} of t9-gate: bravo approved it; it carries to base2..rebased2, whose held files and findings are unchanged`));
    assert.deepEqual(await gate.hold(), first, 'the approved hold stays, as the change a later rebase is compared with');
  });

  it('holds it again where main or the branch changed a held file, or git cannot read the old commits', async () => {
    for (const commit of ['base2', 'rebased2']) {
      const { gate, first } = await approvedAndRebased();
      gate.git.blobs.set(`${commit}:package-lock.json`, 'blob-changed');
      assert.match((await gate.run(MOVED)) ?? '', /^review hold H\w+ keeps t9-gate \(base2\.\.rebased2\)/, commit);
      assert.notEqual((await gate.hold()).id, first.id, commit);
    }
    const { gate } = await approvedAndRebased();
    gate.git.unreadable.add('rebased');
    assert.match((await gate.run(MOVED)) ?? '', /^review hold H\w+ keeps t9-gate \(base2\.\.rebased2\)/);
  });

  it('holds it again where it holds other paths, or for another reviewer', async () => {
    const { gate } = await approvedAndRebased();
    gate.git.paths = [...HELD, 'yarn.lock'];
    gate.keepFiles('base', 'base2', ['yarn.lock']);
    gate.keepFiles('rebased', 'rebased2', ['yarn.lock']);
    assert.match((await gate.run(MOVED)) ?? '', /^review hold H\w+ keeps t9-gate \(base2\.\.rebased2\) off the default branch: it changes package-lock\.json, src\/auth\/old\.ts \(src\/auth\/\*\*\), yarn\.lock\./);
    const moved = await approvedAndRebased();
    assert.match((await moved.gate.run(MOVED, { ...SETUP, roles: { securityReviewer: 'charlie' } })) ?? '', /charlie answers it/);
  });

  it('carries a flagged hold only while the review check finds the same', async () => {
    const { gate } = await approvedAndRebased(['src/auth/login.ts'], CHECKED, { kind: 'flagged', findings: 'token in login.ts' });
    assert.deepEqual(await gate.verdict({ ...CHECKED, ...MOVED }), { kind: 'clear', review: 'approved' });
    assert.deepEqual(gate.checks, ['node review.js @ base', 'node review.js @ base2']);
    gate.outcome = { kind: 'flagged', findings: 'token in login.ts and session.ts' };
    assert.match((await gate.run({ ...CHECKED, ...MOVED })) ?? '', /keeps t9-gate \(base2\.\.rebased2\) off the default branch: .*the review check flagged it/);
  });

  it('holds it again where its hold was never approved, or was declined after the approval', async () => {
    const never = new Gate(HELD);
    await never.run();
    never.keepFiles('base', 'base2', HELD);
    never.keepFiles('rebased', 'rebased2', HELD);
    assert.match((await never.run(MOVED)) ?? '', /^review hold H\w+ keeps t9-gate \(base2\.\.rebased2\)/);
    const { gate } = await approvedAndRebased();
    gate.answer('declined', 'bravo', 'one more look');
    assert.match((await gate.run(MOVED)) ?? '', /^review hold H\w+ keeps t9-gate \(base2\.\.rebased2\)/);
  });
});

describe('reviewGateVerdict: what it refuses outright', () => {
  it('refuses a branch that names no task of the session, and holds nothing', async () => {
    const gate = new Gate(['package-lock.json']);
    gate.tasks.set('T11', { owner: 'bravo', answer: null });
    const refusals = [await gate.run({ branch: 'gate-fix' }), await gate.run({ branch: 't10-gate' }), await gate.run({ branch: 't11-gate' })];
    assert.match(refusals[0] ?? '', /the branch names none: name it t<n>-… after your task$/);
    assert.match(refusals[1] ?? '', /its task T10, which is not in the register: merge a branch named after a task of alpha$/);
    assert.match(refusals[2] ?? '', /its task T11, which is bravo's/);
    for (const branch of ['gate-fix', 't10-gate', 't11-gate']) {
      assert.equal(await gate.holds.read(CHANGE.repo, branch), undefined);
    }
  });

  it('refuses where no one but the session could review it', async () => {
    const gate = new Gate(['package-lock.json']);
    gate.tasks.set('T9', { owner: 'lead', answer: null });
    const refusal = await gate.run({ session: 'lead' }, { ...SETUP, roles: {} });
    assert.match(refusal ?? '', /which the review gate holds, but no one but lead could review its change: set roles\.securityReviewer to another session$/);
  });

  it('refuses a change it cannot read', async () => {
    assert.equal(await new Gate(undefined).run(), 'could not read what t9-gate changes against base, so the review gate cannot clear it');
    assert.equal(await new Gate(['package-lock.json']).run({ top: '/nowhere', head: 'HEAD' }), 'could not read the tree HEAD makes, so the review gate cannot bind a hold to it');
  });
});
