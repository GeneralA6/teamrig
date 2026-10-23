import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TEST_CARD, TEST_CARD_FLAGS } from '../testing/card.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** Batch times at the lead's checkpoints; the clock is Tue 01-08 10:00, after the 19:03 one of the day before. */
const BATCHED = { ...TEAM, decisions: { batchTimesUtc: ['13:03', '19:03'], batchAt: 2 } };
const WAIT_LINE = `NOTE lead has an inbox line: T1 waits on the owner's decision: ${TEST_CARD.question}`;

/** Adds a task of alpha's and sets it waiting on the owner's decision, with its card; returns what the set printed on stderr. */
async function ownerWait(kit: CliHarness, title: string, ...extra: readonly string[]): Promise<readonly string[]> {
  const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', ...extra, '--session', 'alpha']);
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
  const id = /^ADDED (T\d+)/.exec(added.stdout[0] ?? '')?.[1] ?? '';
  const set = await kit.run(['set', id, '--status', 'waiting', '--waits', 'decision:owner', '--note', 'two options', ...TEST_CARD_FLAGS, '--session', 'alpha']);
  assert.equal(set.code, EXIT.ok, set.stderr.join('\n'));
  return set.stderr;
}

async function decisionLines(kit: CliHarness, session: string): Promise<readonly string[]> {
  return (await kit.run(['check', '--session', session])).stdout.filter((line) => line.startsWith('DECISIONS'));
}

describe('runCli: the owner decisions the lead asks in batches', () => {
  it('prints the waits not yet asked and when the next batch is, to any session; the check is quiet until a batch is due', async () => {
    const kit = new CliHarness(BATCHED);
    assert.deepEqual(await ownerWait(kit, 'Pick the pricing tier'), [`${WAIT_LINE} | asked in the next batch Tue 01-08 13:03 UTC`]);
    const listed = await kit.run(['decisions', '--session', 'alpha']);
    assert.equal(listed.code, EXIT.ok, listed.stderr.join('\n'));
    assert.deepEqual(listed.stdout.slice(0, 2), ['DECISIONS 1 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC', 'NOT YET ASKED']);
    assert.match(listed.stdout[2] ?? '', /^ {2}T1 waiting, p2, owner alpha \| Pick the pricing tier/);
    assert.ok(listed.stdout.includes(`    decide: ${TEST_CARD.question}`), listed.stdout.join('\n'));
    assert.deepEqual(await decisionLines(kit, 'lead'), []);
  });

  it("is due once batchAt waits are not yet asked: the lead's check names it until the lead records the batch asked", async () => {
    const kit = new CliHarness(BATCHED);
    await ownerWait(kit, 'Pick the pricing tier');
    const second = await ownerWait(kit, 'Pick the launch day');
    assert.deepEqual(second, [`NOTE lead has an inbox line: T2 waits on the owner's decision: ${TEST_CARD.question} | BATCH DUE: 2 not yet asked, decisions.batchAt is 2`]);
    const due = 'DECISIONS batch due (2 not yet asked, decisions.batchAt is 2): 2 to ask, 0 past due; teamrig decisions --session lead';
    assert.deepEqual(await decisionLines(kit, 'lead'), [due]);
    assert.ok((await kit.run(['start', '--session', 'lead'])).stdout.includes(due));
    assert.ok(!(await kit.run(['start', '--session', 'alpha'])).stdout.includes(due), 'only the lead acts on the batch');

    const refused = await kit.run(['decisions', 'asked', '--session', 'alpha']);
    assert.deepEqual([refused.code, refused.stdout], [EXIT.refused, ["REFUSED only the lead (app-lead) asks the owner's decisions"]]);
    const asked = await kit.run(['decisions', 'asked', '--session', 'lead']);
    assert.equal(asked.code, EXIT.ok, asked.stderr.join('\n'));
    assert.deepEqual(asked.stdout, ['ASKED 2 decision(s) Tue 01-08 10:00 UTC: T1, T2; the next batch Tue 01-08 13:03 UTC holds the waits set since and the ones past due']);
    assert.deepEqual(await decisionLines(kit, 'lead'), []);
    assert.deepEqual((await kit.run(['decisions', '--session', 'lead'])).stdout, ['DECISIONS 0 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC']);
  });

  it('asks a wait due before the next batch at once, and tells the setter to message the lead too', async () => {
    const kit = new CliHarness(BATCHED);
    assert.deepEqual(await ownerWait(kit, 'Pick the pricing tier', '--due', '2030-01-08 12:00'), [
      `${WAIT_LINE} | AT ONCE, due Tue 01-08 12:00 UTC before the next batch`,
      "NOTE T1 is due before the owner's next batch: message app-lead too, as an inbox line wakes no one",
    ]);
    assert.deepEqual(await decisionLines(kit, 'lead'), ['DECISIONS batch due (T1 is due Tue 01-08 12:00 UTC, before the next batch): 1 to ask, 0 past due; teamrig decisions --session lead']);
  });

  it("tells a sub-lead's member's own leader of a wait due at once, and the setter to message the lead", async () => {
    const kit = new CliHarness({ ...BATCHED, leads: { bravo: ['alpha'] } });
    assert.deepEqual(await ownerWait(kit, 'Pick the pricing tier', '--due', '2030-01-08 12:00'), [
      `NOTE bravo has an inbox line: T1 waits on the owner's decision: ${TEST_CARD.question} | AT ONCE, due Tue 01-08 12:00 UTC before the next batch`,
      "NOTE T1 is due before the owner's next batch: message app-lead, who asks the owner: the inbox line went to bravo, and a line wakes no one",
    ]);
    assert.deepEqual(await decisionLines(kit, 'lead'), ['DECISIONS batch due (T1 is due Tue 01-08 12:00 UTC, before the next batch): 1 to ask, 0 past due; teamrig decisions --session lead']);
  });

  it("reads and prints every time on the team's clock", async () => {
    const kit = new CliHarness({ ...BATCHED, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(await ownerWait(kit, 'Pick the pricing tier', '--due', '2030-01-08 14:00'), [
      `${WAIT_LINE} | AT ONCE, due Tue 01-08 14:00 IST before the next batch`,
      "NOTE T1 is due before the owner's next batch: message app-lead too, as an inbox line wakes no one",
    ]);
    assert.deepEqual(await decisionLines(kit, 'lead'), ['DECISIONS batch due (T1 is due Tue 01-08 14:00 IST, before the next batch): 1 to ask, 0 past due; teamrig decisions --session lead']);
    assert.deepEqual((await kit.run(['decisions', 'asked', '--session', 'lead'])).stdout, [
      'ASKED 1 decision(s) Tue 01-08 12:00 IST: T1; the next batch Tue 01-08 15:03 IST holds the waits set since and the ones past due',
    ]);
  });

  it('counts a meeting start as a batch asked, and records nothing with no wait to ask', async () => {
    const kit = new CliHarness(BATCHED);
    await ownerWait(kit, 'Pick the pricing tier');
    await kit.run(['meeting', 'start', '--session', 'lead']);
    assert.equal((await kit.run(['decisions', '--session', 'lead'])).stdout[0], 'DECISIONS 0 to ask owner, 0 asked and past due; the next batch Tue 01-08 13:03 UTC');
    assert.deepEqual((await kit.run(['decisions', 'asked', '--session', 'lead'])).stdout, ['ASKED nothing: no wait on owner to ask; nothing recorded']);
    assert.equal(kit.files.get(join(TEAM_HOME, 'state', 'decisions-asked.json')), undefined);
  });
});
