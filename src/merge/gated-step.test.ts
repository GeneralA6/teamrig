import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMMITS } from '../config/defaults.ts';
import { LeadTree } from '../config/lead-tree.ts';
import type { CommitStat } from '../push-guard/commit-size.ts';
import type { PassRecord } from '../push-guard/pass-record.ts';
import type { ApprovalVerdict } from '../register/events.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { GateHolds, type GateHold } from './gate-holds.ts';
import { gatedVerdict, type GatedChange, type GatedSetup, type GatedTask, type GatedVerdict } from './gated-step.ts';

const MINUTE_MS = 60_000;
const TREE = 'e'.repeat(40);
const SETUP: GatedSetup = { tree: new LeadTree(testConfig()), roles: { securityReviewer: 'bravo' }, commits: DEFAULT_COMMITS };
const CHANGE: GatedChange = { session: 'alpha', repo: 'app', reviewGate: true, branch: 't9-gate', base: 'b'.repeat(40), head: 'h'.repeat(40) };
const PASS: PassRecord = { tree: TREE, commit: 'h'.repeat(40), checks: ['unit', 'lint'], passedAt: '2030-01-08T09:00:00.000Z', node: 'v24.0.0' };
const COMMITS: readonly CommitStat[] = [
  {
    sha: 'a'.repeat(40),
    subject: 'Gate the store',
    body: '',
    files: [
      { path: 'src/store.ts', added: 10, deleted: 0 },
      { path: 'src/store.test.ts', added: 5, deleted: 2 },
    ],
  },
  { sha: 'c'.repeat(40), subject: 'Name it', body: '', files: [{ path: 'src/{old.ts => store.ts}', added: 1, deleted: 1 }] },
];
const FACTS = { task: 'T9', tree: TREE, files: 2, lines: 19, checks: ['unit', 'lint'] };

/** The step over a register of tasks, a hold folder in memory, and a checkout whose tree, commits and pass record are set here. */
class Step {
  readonly holds = new GateHolds(new MemoryFiles(), '/team/deploys/gate-holds');
  readonly clock = new FakeClock('2030-01-08T10:00:00Z');
  readonly tasks = new Map<string, GatedTask>([['T9', { owner: 'alpha', status: 'in-progress', answer: null }]]);
  readonly said: string[] = [];
  tree: string | undefined = TREE;
  commits: readonly CommitStat[] | undefined = COMMITS;
  pass: PassRecord | undefined = PASS;

  run(change: Partial<GatedChange> = {}, setup: GatedSetup = SETUP): Promise<GatedVerdict> {
    return gatedVerdict(
      setup,
      {
        holds: this.holds,
        clock: this.clock,
        taskOf: async (id) => this.tasks.get(id),
        treeOf: () => this.tree,
        commitsOf: () => this.commits,
        passOf: async (tree) => (tree === this.pass?.tree ? this.pass : undefined),
        say: (text) => this.said.push(text),
      },
      { ...CHANGE, ...change },
    );
  }

  /** T9's approval wait is answered now. */
  answer(verdict: ApprovalVerdict, by: string, note: string | null = null): void {
    const task = this.tasks.get('T9');
    assert.ok(task !== undefined);
    this.tasks.set('T9', { ...task, answer: { verdict, by, at: new Date(this.clock.now()).toISOString(), note } });
  }

  async hold(): Promise<GateHold> {
    const hold = await this.holds.read(CHANGE.repo, CHANGE.branch);
    assert.ok(hold !== undefined, 'a hold was made');
    return hold;
  }
}

function reasonOf(verdict: GatedVerdict): string {
  assert.equal(verdict.kind, 'held');
  return verdict.kind === 'held' ? verdict.reason : '';
}

describe('gatedVerdict: a change that holds every gate', () => {
  it('merges with no approval and no hold, with what the merges log keeps of it', async () => {
    const step = new Step();
    assert.deepEqual(await step.run(), { kind: 'self', facts: FACTS });
    assert.equal(await step.holds.read('app', 't9-gate'), undefined);
    assert.deepEqual(step.said, ['self-merge gates of t9-gate: every gate holds, so it merges with no approval']);
  });

  it('is held when git cannot read its tree or its commits', async () => {
    const step = new Step();
    step.tree = undefined;
    assert.match(reasonOf(await step.run()), /^could not read the tree hhhhhhhh makes/);
    step.tree = TREE;
    step.commits = undefined;
    assert.match(reasonOf(await step.run()), /^could not read the commits of t9-gate against bbbbbbbb/);
  });
});

describe('gatedVerdict: the task gate', () => {
  it('holds nothing, as an approval needs a live task of the session', async () => {
    const step = new Step();
    assert.equal(
      reasonOf(await step.run({ branch: 'gate' })),
      "task: gate names no task: name the branch t<n>-… after your task. A missed gate waits on the approval of the branch's task, so gate must name a live task of alpha's first",
    );
    step.tasks.set('T9', { owner: 'bravo', status: 'open', answer: null });
    assert.match(reasonOf(await step.run()), /^task: T9 is bravo's, not alpha's\. /);
    step.tasks.set('T9', { owner: 'alpha', status: 'done', answer: null });
    step.pass = undefined;
    assert.match(reasonOf(await step.run()), /^task: T9 is done; pass: /);
    assert.equal(await step.holds.read('app', 't9-gate'), undefined);
  });
});

describe('gatedVerdict: a held change', () => {
  it("is held for the session's leader, bound to the change, with the command that asks", async () => {
    const step = new Step();
    step.pass = undefined;
    const reason = reasonOf(await step.run());
    const hold = await step.hold();
    assert.deepEqual({ ...hold, id: 'G' }, {
      id: 'G',
      repo: 'app',
      branch: 't9-gate',
      base: CHANGE.base,
      head: CHANGE.head,
      tree: TREE,
      task: 'T9',
      session: 'alpha',
      reviewer: 'lead',
      misses: [{ gate: 'pass', why: "no pass record proves the rebased tree eeeeeeee: run the repo's local checks on the rebased branch, then merge again" }],
      createdAt: '2030-01-08T10:00:00.000Z',
    });
    assert.equal(
      reason,
      `gate hold ${hold.id} keeps t9-gate (bbbbbbbb..hhhhhhhh) off the default branch: ${`pass: ${hold.misses[0]?.why ?? ''}`}. lead answers it: ` +
        `teamrig set T9 --status waiting --waits approval:lead --note "gate hold ${hold.id} of t9-gate bbbbbbbb..hhhhhhhh" --session alpha; merge again once it is approved`,
    );
    assert.deepEqual(step.said, [`gate hold ${hold.id} of app t9-gate: waits on lead`]);
  });

  it('merges once its leader approved it after the hold, naming the gates it missed', async () => {
    const step = new Step();
    step.pass = undefined;
    await step.run();
    step.clock.advance(MINUTE_MS);
    step.answer('approved', 'lead');
    assert.deepEqual(await step.run(), { kind: 'approved', facts: { ...FACTS, checks: [] }, missed: ['pass'], approvedBy: 'lead' });
  });

  it('stays held on an approval from before the hold or from anyone but its leader, keeping its hold', async () => {
    const step = new Step();
    step.pass = undefined;
    step.answer('approved', 'lead');
    step.clock.advance(MINUTE_MS);
    const first = reasonOf(await step.run());
    const made = await step.hold();
    step.clock.advance(MINUTE_MS);
    assert.equal(reasonOf(await step.run()), first);
    step.answer('approved', 'bravo');
    assert.equal(reasonOf(await step.run()), first);
    assert.deepEqual(await step.hold(), made);
  });

  it('says so when its task was declined after the hold', async () => {
    const step = new Step();
    step.pass = undefined;
    await step.run();
    const { id } = await step.hold();
    step.clock.advance(MINUTE_MS);
    step.answer('declined', 'lead', 'split it\nfirst');
    assert.equal(reasonOf(await step.run()), `gate hold ${id}: lead declined T9 (split it first); change t9-gate, then merge again for a new hold`);
  });

  it('gets a new hold for any other change of the branch', async () => {
    const step = new Step();
    step.pass = undefined;
    await step.run();
    const old = await step.hold();
    step.clock.advance(MINUTE_MS);
    step.answer('approved', 'lead');
    step.clock.advance(MINUTE_MS);
    assert.equal((await step.run({ head: 'n'.repeat(40) })).kind, 'held');
    const made = await step.hold();
    assert.notEqual(made.id, old.id);
    assert.equal(made.head, 'n'.repeat(40));
  });

  it('merges on an approval when it misses fewer gates than its hold named, and is held anew when it misses more', async () => {
    const step = new Step();
    step.pass = undefined;
    await step.run({ reviewGate: false });
    step.clock.advance(MINUTE_MS);
    step.answer('approved', 'lead');
    step.pass = PASS;
    assert.deepEqual(await step.run({ reviewGate: false }), { kind: 'approved', facts: FACTS, missed: ['review'], approvedBy: 'lead' });

    const fresh = new Step();
    await fresh.run({ reviewGate: false });
    fresh.clock.advance(MINUTE_MS);
    fresh.answer('approved', 'lead');
    fresh.pass = undefined;
    fresh.clock.advance(MINUTE_MS);
    assert.equal((await fresh.run({ reviewGate: false })).kind, 'held');
    assert.deepEqual((await fresh.hold()).misses.map((miss) => miss.gate), ['pass', 'review']);
  });

  it("sends the lead's own change to security, and holds it with no route when there is none", async () => {
    const step = new Step();
    step.tasks.set('T9', { owner: 'lead', status: 'open', answer: null });
    step.pass = undefined;
    await step.run({ session: 'lead' });
    assert.equal((await step.hold()).reviewer, 'bravo');
    const alone = new Step();
    alone.tasks.set('T9', { owner: 'lead', status: 'open', answer: null });
    alone.pass = undefined;
    const reason = reasonOf(await alone.run({ session: 'lead' }, { ...SETUP, roles: {} }));
    assert.match(reason, /^t9-gate misses the self-merge gates \(pass: .*\), but no one but lead could review its change/);
    assert.equal(await alone.holds.read('app', 't9-gate'), undefined);
  });
});
