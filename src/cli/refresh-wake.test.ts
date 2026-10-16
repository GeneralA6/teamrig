import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { RefreshState } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM_HOME } from '../testing/cli-harness.ts';
import { WAKE_POLL_MS, WAKE_WAIT_MS } from './commands/hook-refresh-wake.ts';
import { EXIT } from './runtime.ts';

const HANDOVER = join(TEAM_HOME, 'handover', 'alpha.md');
const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };

function startPayload(source: string): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source });
}

function storeOf(kit: CliHarness): RefreshStore {
  return new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
}

/** Alpha's refresh as SessionStart leaves it after the /clear took it, at the harness's now. */
function taken(kit: CliHarness): RefreshState {
  return { phase: 'refreshed', task: 'T3', at: new Date(kit.clock.now()).toISOString() };
}

describe('teamrig hook refresh-wake', () => {
  it('wakes the session a /clear just started from its refresh, with exit 2 and its handover on stderr', async () => {
    const kit = new CliHarness();
    await storeOf(kit).setState('alpha', taken(kit));
    const woken = await kit.run(['hook', 'refresh-wake'], { ...AS_ALPHA, stdin: startPayload('clear') });
    assert.deepEqual(woken, {
      code: EXIT.wake,
      stdout: [],
      stderr: [`You were started fresh after your context refresh at T3: read your handover ${HANDOVER} now, take over what the SessionStart note lists, then carry on with its next steps.`],
    });
  });

  it('waits for the SessionStart hook beside it to take the refresh', async () => {
    const kit = new CliHarness();
    const store = storeOf(kit);
    await store.setState('alpha', { phase: 'ready', task: 'T3', at: new Date(kit.clock.now()).toISOString(), noticed: true, transcript: null, claudePid: null });
    let waits = 0;
    const sleep = async (ms: number): Promise<void> => {
      waits += 1;
      await kit.clock.sleep(ms);
      if (waits === 3) {
        await store.setState('alpha', taken(kit));
      }
    };
    assert.equal((await kit.run(['hook', 'refresh-wake'], { ...AS_ALPHA, stdin: startPayload('clear'), sleep })).code, EXIT.wake);
    assert.equal(waits, 3, 'it looked again until the refresh was taken');
  });

  it('wakes nothing at another start, or at a /clear that took no refresh, after waiting at most its limit', async () => {
    const kit = new CliHarness();
    await storeOf(kit).setState('alpha', taken(kit));
    for (const source of ['startup', 'resume', 'compact']) {
      assert.deepEqual(await kit.run(['hook', 'refresh-wake'], { ...AS_ALPHA, stdin: startPayload(source) }), { code: EXIT.ok, stdout: [], stderr: [] }, source);
    }
    assert.deepEqual(kit.clock.sleeps, [], 'nothing waited for');

    kit.clock.advance(60_000);
    assert.deepEqual(await kit.run(['hook', 'refresh-wake'], { ...AS_ALPHA, stdin: startPayload('clear') }), { code: EXIT.ok, stdout: [], stderr: [] }, 'an earlier refresh');
    assert.equal(kit.clock.sleeps.length, WAKE_WAIT_MS / WAKE_POLL_MS);
    assert.deepEqual(await kit.run(['hook', 'refresh-wake'], { stdin: startPayload('clear') }), { code: EXIT.ok, stdout: [], stderr: [] }, 'a tab of no session');
  });
});
