import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION } from '../register/events.ts';
import { TEST_CARD, TEST_CARD_FLAGS, TEST_GATE, TEST_OWNER_CARD_FLAGS } from '../testing/card.ts';
import { CliHarness, EVENTS_PATH } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

async function inboxOf(kit: CliHarness, session: string): Promise<string[]> {
  const read = await kit.run(['inbox', 'read', '--session', session]);
  return read.stdout.filter((line) => line.startsWith('- '));
}

/** A harness where alpha has started T1, a p2 task the lead gave it. */
async function startedTask(): Promise<CliHarness> {
  const kit = new CliHarness();
  const added = await kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  assert.equal(started.code, EXIT.ok, started.stderr.join('\n'));
  await inboxOf(kit, 'alpha');
  return kit;
}

describe('runCli: set --ask asks a peer for work by a task', () => {
  it("adds the asked session's task, sets the caller's waiting on it and tells the asked session", async () => {
    const kit = await startedTask();
    const asked = await kit.run(['set', 'T1', '--status', 'waiting', '--ask', 'bravo', '--text', 'Land the schema change', '--due', '2030-01-10', '--session', 'alpha']);
    assert.equal(asked.code, EXIT.ok, asked.stderr.join('\n'));
    assert.deepEqual(asked.stdout, [
      'ADDED T2 open, p2, owner bravo, due 01-10, from alpha | Land the schema change · needed by T1 (alpha)',
      'SET T1 waiting, p2, owner alpha, from lead | Ship the release (waiting: on T2; Land the schema change)',
    ]);
    assert.deepEqual(asked.stderr, ['NOTE bravo has an inbox line: T2 is yours (p2, due 2030-01-10): Land the schema change']);
    assert.deepEqual(await inboxOf(kit, 'bravo'), ['- 2030-01-08 10:00 UTC alpha: T2 is yours (p2, due 2030-01-10): Land the schema change']);
    const shown = await kit.run(['show', 'T2', '--session', 'bravo']);
    assert.match(shown.stdout.join('\n'), /description: Asked by alpha for T1 \(Ship the release\), which waits on this task\./);
  });

  it("refuses asking for a verifying task's proof, since the asked task starts open: the task waits on it instead", async () => {
    const kit = await startedTask();
    const proof = ['--proof', 'the nightly run is green', '--note', 'shipped', '--followups', 'none'];
    const before = kit.files.get(EVENTS_PATH);
    const refused = await kit.run(['set', 'T1', '--status', 'verifying', ...proof, '--ask', 'bravo', '--text', 'Run the build tonight', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(
      [...refused.stdout, ...refused.stderr].join('\n'),
      /REFUSED --ask goes only with --status waiting: the asked task starts open, .* \(teamrig set T1 --status waiting --ask bravo --text "Run the build tonight"\)/,
    );
    assert.equal(kit.files.get(EVENTS_PATH), before);
    const asked = await kit.run(['set', 'T1', '--status', 'waiting', '--ask', 'bravo', '--text', 'Run the build tonight', '--session', 'alpha']);
    assert.equal(asked.code, EXIT.ok, asked.stderr.join('\n'));
    assert.deepEqual(asked.stderr, ['NOTE bravo has an inbox line: T2 is yours (p2): Run the build tonight']);
    assert.match(asked.stdout.join('\n'), /SET T1 waiting, .* \(waiting: on T2; Run the build tonight\)/);
  });

  it("parks a verifying task on the owner's approval beside the time its proof runs", async () => {
    const kit = await startedTask();
    const proof = ['--proof', 'the owner tries it', '--note', 'shipped', '--followups', 'none'];
    const owner = await kit.run(['set', 'T1', '--status', 'verifying', ...proof, '--waits', 'approval:owner,time:2030-01-08 22:00', ...TEST_CARD_FLAGS, '--session', 'alpha']);
    assert.equal(owner.code, EXIT.ok, owner.stderr.join('\n'));
    assert.deepEqual(owner.stderr, [`NOTE lead has an inbox line: T1 waits on the owner's approval: ${TEST_CARD.question} | asked in the next batch at the daily meeting`]);
  });

  it("refuses a peer's approval with the ask to make, and writes nothing", async () => {
    const kit = await startedTask();
    const before = kit.files.get(EVENTS_PATH);
    const peer = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:bravo', '--note', 'the schema', '--session', 'alpha']);
    assert.equal(peer.code, EXIT.refused);
    assert.match(
      [...peer.stdout, ...peer.stderr].join('\n'),
      /REFUSED approval bravo: approval waits are for the lead \(lead\) and owner; wait on bravo's work by its task: teamrig set T1 --status waiting --ask bravo --text "<the work you need>"/,
    );
    assert.equal(kit.files.get(EVENTS_PATH), before);

    const open = await kit.run(['add', '--title', 'Plan the launch', '--description', 'what and why', '--priority', 'p3', '--session', 'alpha']);
    assert.equal(open.code, EXIT.ok);
    const added = kit.files.get(EVENTS_PATH);
    const early = await kit.run(['set', 'T2', '--status', 'waiting', '--ask', 'bravo', '--text', 'Land it', '--session', 'alpha']);
    assert.match([...early.stdout, ...early.stderr].join('\n'), /REFUSED T2 has not started, so it does not wait: ask with teamrig add --owner bravo/);
    assert.equal(kit.files.get(EVENTS_PATH), added);
  });
});

describe('runCli: a wait on the lead or the owner tells the lead', () => {
  it('posts one line per new wait, never for the same waits again, nor when the lead sets it', async () => {
    const kit = await startedTask();
    const approval = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'pick the backup window', '--session', 'alpha']);
    assert.equal(approval.code, EXIT.ok, approval.stderr.join('\n'));
    assert.deepEqual(approval.stderr, ['NOTE lead has an inbox line: T1 waits on your approval: pick the backup window']);

    const again = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'the window is Sunday', '--session', 'alpha']);
    assert.deepEqual([again.code, again.stderr], [EXIT.ok, []]);
    const owner = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead,decision:owner', '--note', 'and the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']);
    assert.deepEqual(owner.stderr, [`NOTE lead has an inbox line: T1 waits on the owner's decision: ${TEST_CARD.question} | asked in the next batch at the daily meeting`]);
    assert.deepEqual(await inboxOf(kit, 'lead'), [
      '- 2030-01-08 10:00 UTC alpha: T1 waits on your approval: pick the backup window',
      `- 2030-01-08 10:00 UTC alpha: T1 waits on the owner's decision: ${TEST_CARD.question} | asked in the next batch at the daily meeting`,
    ]);

    await kit.run(['add', '--title', 'Plan the week', '--description', 'what and why', '--priority', 'p2', '--session', 'lead']);
    await kit.run(['set', 'T2', '--status', 'in-progress', '--session', 'lead']);
    const own = await kit.run(['set', 'T2', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the budget', ...TEST_OWNER_CARD_FLAGS, '--session', 'lead']);
    assert.deepEqual([own.code, own.stderr], [EXIT.ok, []]);
  });

  it('tells the lead of a wait set with an ask, after the asked session', async () => {
    const kit = await startedTask();
    const asked = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--ask', 'bravo', '--text', 'Land it', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']);
    assert.equal(asked.code, EXIT.ok, asked.stderr.join('\n'));
    assert.deepEqual(asked.stderr, ['NOTE bravo has an inbox line: T2 is yours (p2): Land it', `NOTE lead has an inbox line: T1 waits on the owner's decision: ${TEST_CARD.question} | asked in the next batch at the daily meeting`]);
  });

  it("tells a sub-lead of a wait on its approval and of one on the owner, which the lead asks in its batch", async () => {
    const kit = new CliHarness({ sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' }, leads: { alpha: ['bravo'] } });
    await kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p2', '--session', 'bravo']);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
    const sub = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:alpha', '--note', 'branch t1', '--session', 'bravo']);
    assert.equal(sub.code, EXIT.ok, sub.stderr.join('\n'));
    assert.deepEqual(sub.stderr, ['NOTE alpha has an inbox line: T1 waits on your approval: branch t1']);
    const owner = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:alpha,decision:owner', '--note', 'and the cost', ...TEST_OWNER_CARD_FLAGS, '--session', 'bravo']);
    assert.deepEqual(owner.stderr, [`NOTE alpha has an inbox line: T1 waits on the owner's decision: ${TEST_CARD.question} | asked in the next batch at the daily meeting`]);
    assert.deepEqual(await inboxOf(kit, 'lead'), []);
  });

  it('names a line it could not post, and keeps the wait', async () => {
    const kit = new CliHarness({ sessions: ['lead', 'alpha', 'bravo'], roles: { lead: 'lead' }, register: { secretPatterns: ['waits on your'] } });
    await kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    const approval = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:lead', '--note', 'the window', '--session', 'alpha']);
    assert.equal(approval.code, EXIT.ok);
    assert.deepEqual(approval.stderr.map((line) => line.split(':')[0]), ['WARN lead was not told that T1 waits on it']);
  });
});

describe('runCli: check flags a peer wait an older teamrig wrote', () => {
  it('reads the stored wait and names the ask to make', async () => {
    const kit = await startedTask();
    const status = {
      v: EVENT_VERSION,
      type: 'status',
      id: 'T1',
      at: '2030-01-08T10:00:00.000Z',
      by: 'alpha',
      status: 'waiting',
      note: 'n',
      evidence: null,
      skill: null,
      waits: [{ kind: 'approval', who: 'bravo' }],
    };
    await kit.files.append(EVENTS_PATH, `${JSON.stringify(status)}\n`);
    const checked = await kit.run(['check', '--all', '--session', 'lead']);
    assert.equal(checked.code, EXIT.ok, checked.stderr.join('\n'));
    assert.ok(
      checked.stdout.includes(
        `PEER-WAIT (approval:bravo is a peer's work: wait on it by its task (set T1 --status waiting --ask bravo --text "<the work>")) T1 waiting, Improvements, score 3.33, p2, owner alpha, from lead | Ship the release (waiting: approval bravo; n)`,
      ),
      checked.stdout.join('\n'),
    );
  });
});

describe('runCli: the decision card', () => {
  it("refuses a wait on the owner's decision without a card, and shows the card it takes", async () => {
    const kit = await startedTask();
    const bare = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', '--session', 'alpha']);
    assert.equal(bare.code, EXIT.refused);
    assert.match([...bare.stdout, ...bare.stderr].join('\n'), /REFUSED a wait on owner's decision needs a card, so owner decides from it alone: --question /);
    assert.match([...bare.stdout, ...bare.stderr].join('\n'), /--gate "<destructive data operations, .+ or business>"/);
    const carded = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_OWNER_CARD_FLAGS, '--session', 'alpha']);
    assert.equal(carded.code, EXIT.ok, carded.stderr.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n');
    const lines = shown.split('\n');
    assert.ok(lines.some((line) => line.endsWith(`decide: ${TEST_CARD.question}`)), shown);
    assert.ok(lines.some((line) => line.endsWith(`gate: ${TEST_GATE}`)), shown);
    assert.ok(lines.some((line) => line.endsWith(`2. ${TEST_CARD.options[1] ?? ''}`)), shown);
  });

  it('keeps a \\| inside a choice as a literal |, and a bare | in one shows how the choices split', async () => {
    const kit = await startedTask();
    const card = (options: string): string[] => ['set', 'T1', '--status', 'waiting', '--waits', 'decision:owner', '--note', 'the token row', '--options', options, ...TEST_OWNER_CARD_FLAGS.filter((_, index, all) => all[index] !== '--options' && all[index - 1] !== '--options'), '--session', 'alpha'];
    const bare = await kit.run(card("Approve: add the row 'Account | D1 | Edit' to the token | Decline: keep the token as it is"));
    assert.equal(bare.code, EXIT.refused);
    const said = [...bare.stdout, ...bare.stderr].join('\n');
    assert.match(said, /--options choice 2 says "D1"/);
    assert.match(said, /--options split into 4 choices at each \|: "Approve: add the row 'Account" \/ "D1" \/ "Edit' to the token" \/ "Decline: keep the token as it is"; write \\\| for a \| inside a choice/);
    const escaped = await kit.run(card("Approve: add the row 'Account \\| D1 \\| Edit' to the token | Decline: keep the token as it is"));
    assert.equal(escaped.code, EXIT.ok, escaped.stderr.join('\n'));
    const shown = (await kit.run(['show', 'T1', '--session', 'alpha'])).stdout.join('\n').split('\n');
    assert.ok(shown.some((line) => line.endsWith("1. Approve: add the row 'Account | D1 | Edit' to the token")), shown.join('\n'));
    assert.ok(shown.some((line) => line.endsWith('2. Decline: keep the token as it is')), shown.join('\n'));
  });
});
