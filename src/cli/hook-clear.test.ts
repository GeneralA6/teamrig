import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { outcomeFileOf } from '../mod/clear-hand.ts';
import { ClearAsks, clearAskDir, type ClearAsk } from '../refresh/clear-asks.ts';
import { RefreshStore } from '../refresh/store.ts';
import { CLAUDE_SESSION, CliHarness, KIT, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AT = '2030-01-08T09:59:59.000Z';
const ASK_DIR = clearAskDir(KIT);
const OUTCOME = outcomeFileOf(ASK_DIR, CLAUDE_SESSION) ?? '';
const CLAIM = ['hook', 'clear-claim'];
const HOLD = ['hook', 'clear-claim', '--hold'];
const PERSON_HOLD = { countdownMs: 20_000, afterActivityMs: 300_000 };
const FROM_TAB = { stdin: JSON.stringify({ session_id: CLAUDE_SESSION }) };

interface Asked {
  readonly store: RefreshStore;
  readonly asks: ClearAsks;
}

/** Alpha's restart is pending and the runner asked the tab to run /clear. */
async function asked(kit: CliHarness, ask: Partial<ClearAsk> = {}): Promise<Asked> {
  const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
  await store.setRestart('alpha', { phase: 'pending', at: AT, pid: 4100, claudeSession: CLAUDE_SESSION, transcript: null, cwd: null, supervised: false, effort: null });
  const asks = new ClearAsks(kit.files, ASK_DIR);
  await asks.post(CLAUDE_SESSION, { team: 'app', id: 'alpha', at: AT, askedAt: AT, hold: PERSON_HOLD, askEveryMs: 15_000, ...ask });
  return { store, asks };
}

describe('teamrig hook clear-dir', () => {
  it('prints the folder of the asks under the kit home', async () => {
    const kit = new CliHarness();
    assert.deepEqual(await kit.run(['hook', 'clear-dir']), { code: EXIT.ok, stdout: [ASK_DIR], stderr: [] });
  });
});

describe('teamrig hook clear-claim', () => {
  it('claims the ask of a pending restart and clears the request', async () => {
    const kit = new CliHarness();
    const { store, asks } = await asked(kit);
    assert.deepEqual(await kit.run(CLAIM, FROM_TAB), { code: EXIT.ok, stdout: ['taken'], stderr: [] });
    assert.equal(await asks.outcome(CLAUDE_SESSION), 'taken');
    assert.equal(await store.restart('alpha'), undefined, 'a prompt typed before the /clear is not told the restart was cancelled');
  });

  it('declines when there is no ask, leaving no outcome', async () => {
    const kit = new CliHarness();
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: no ask for this session']);
    assert.equal(kit.files.get(OUTCOME), undefined);
  });

  it('declines an ask whose restart is no longer pending, so the runner withdraws it', async () => {
    const kit = new CliHarness();
    const { store, asks } = await asked(kit, { at: '2030-01-08T09:00:00.000Z' });
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: the restart is no longer pending']);
    await store.clearRestart('alpha');
    await asks.post(CLAUDE_SESSION, { team: 'app', id: 'alpha', at: AT, askedAt: AT, hold: PERSON_HOLD, askEveryMs: 15_000 });
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: the restart is no longer pending'], 'the user typed');
    assert.equal(await asks.withdraw(CLAUDE_SESSION), true);
  });

  it('declines once the runner took its ask back', async () => {
    const kit = new CliHarness();
    const { store, asks } = await asked(kit);
    await asks.withdraw(CLAUDE_SESSION);
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: the restart took its ask back']);
    assert.equal((await store.restart('alpha'))?.phase, 'pending');
  });

  it('declines without a usable session id on stdin', async () => {
    const kit = new CliHarness();
    await asked(kit);
    for (const stdin of ['not json', '{}', JSON.stringify({ session_id: '../x' })]) {
      assert.deepEqual(await kit.run(CLAIM, { stdin }), { code: EXIT.ok, stdout: ['declined: no Claude Code session id on stdin'], stderr: [] }, stdin);
    }
    assert.equal(kit.files.get(OUTCOME), undefined);
  });

  it('declines an ask naming a team that has no such restart', async () => {
    const kit = new CliHarness();
    await asked(kit, { team: 'gone' });
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: the restart is no longer pending']);
    assert.equal(kit.files.get(OUTCOME), undefined);
  });
});

describe('teamrig hook clear-claim --hold', () => {
  it('holds the ask of a pending restart, keeping the request pending so the restart asks again', async () => {
    const kit = new CliHarness();
    const { store, asks } = await asked(kit);
    assert.deepEqual(await kit.run(HOLD, FROM_TAB), { code: EXIT.ok, stdout: ['held'], stderr: [] });
    assert.equal(await asks.outcome(CLAUDE_SESSION), 'held');
    assert.equal(await asks.heldWhy(CLAUDE_SESSION), undefined, 'a hold with no --why, as an older mod gives');
    assert.equal((await store.restart('alpha'))?.phase, 'pending');
    assert.equal(await asks.withdraw(CLAUDE_SESSION), false, 'the restart learns the tab answered first');
  });

  it('keeps the reason --why gives, which the restart names if it gives up', async () => {
    const kit = new CliHarness();
    const { asks } = await asked(kit);
    const why = 'the prompt box holds a draft';
    assert.deepEqual(await kit.run([...HOLD, '--why', why], FROM_TAB), { code: EXIT.ok, stdout: ['held'], stderr: [] });
    assert.equal(await asks.outcome(CLAUDE_SESSION), 'held');
    assert.equal(await asks.heldWhy(CLAUDE_SESSION), why);
  });

  it('declines once the runner took its ask back', async () => {
    const kit = new CliHarness();
    const { asks } = await asked(kit);
    await asks.withdraw(CLAUDE_SESSION);
    assert.deepEqual((await kit.run(HOLD, FROM_TAB)).stdout, ['declined: the restart took its ask back']);
    assert.equal(await asks.outcome(CLAUDE_SESSION), 'withdrawn');
  });

  it('loses to an answer already given, and a claim loses to a hold: the first writer wins', async () => {
    const kit = new CliHarness();
    const { store, asks } = await asked(kit);
    await asks.claim(CLAUDE_SESSION);
    assert.deepEqual((await kit.run(HOLD, FROM_TAB)).stdout, ['declined: the ask was already taken']);
    await asks.post(CLAUDE_SESSION, { team: 'app', id: 'alpha', at: AT, askedAt: AT, hold: PERSON_HOLD, askEveryMs: 15_000 });
    assert.deepEqual((await kit.run(HOLD, FROM_TAB)).stdout, ['held']);
    assert.deepEqual((await kit.run(CLAIM, FROM_TAB)).stdout, ['declined: the ask was already held']);
    assert.equal((await store.restart('alpha'))?.phase, 'pending', 'the lost claim cleared nothing');
  });

  it('declines an ask whose restart is no longer pending, leaving no outcome', async () => {
    const kit = new CliHarness();
    await asked(kit, { at: '2030-01-08T09:00:00.000Z' });
    assert.deepEqual((await kit.run(HOLD, FROM_TAB)).stdout, ['declined: the restart is no longer pending']);
    assert.equal(kit.files.get(OUTCOME), undefined);
  });
});
