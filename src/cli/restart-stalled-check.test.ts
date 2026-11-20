import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HostSource } from '../composition/host-ports.ts';
import type { JsonRecord } from '../core/guards.ts';
import { bareHost } from '../testing/bare-host.ts';
import { RestartLog } from '../refresh/restart-log.ts';
import type { RefreshState, RestartTab } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

/** The harness's clock is 2030-01-08 10:00 UTC. */
const PATHS = { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') };
const TRANSCRIPT = '/claude/projects/app/bravo.jsonl';
const ON = { ...TEAM, refresh: { autoRestart: true } };
const READY: RefreshState = { phase: 'ready', task: 'T4', at: '2030-01-08T09:30:00.000Z', tokens: 150_000, noticed: true, transcript: TRANSCRIPT, claudePid: 4242 };
const TAB: RestartTab = { claudeSession: 'c-bravo', transcript: TRANSCRIPT, cwd: '/work', supervised: false, effort: null };

/** A transcript whose last own entry is a reply that ended its turn at `at`. */
function endedTurnAt(at: string): string {
  return `${JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Handover written.' }] } })}\n`;
}

async function harness(config: JsonRecord = ON, state: RefreshState = READY, lastTurn = '2030-01-08T09:40:00.000Z'): Promise<{ kit: CliHarness; store: RefreshStore }> {
  const kit = new CliHarness(config);
  const store = new RefreshStore(kit.files, PATHS);
  await store.setState('bravo', state);
  await kit.files.write(TRANSCRIPT, endedTurnAt(lastTurn));
  kit.sessionProcesses.add({ pid: 4242, parentPid: 4000, name: 'claude.exe', commandLine: 'claude --resume c-bravo' });
  return { kit, store };
}

/** The check's RESTART-STALLED lines, on the shipped host or on `host`. */
async function stalledLines(kit: CliHarness, host?: HostSource): Promise<string[]> {
  const result = await kit.run(['check', '--all'], { env: { TEAMRIG_SESSION: 'lead' }, ...(host === undefined ? {} : { host }) });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('RESTART-STALLED')).map((line) => line.trim());
}

describe('RESTART-STALLED (#705)', () => {
  it('names a ready, noticed session with no restart pending, quiet past the delay and the margin, with its wait and last restart-log row', async () => {
    const { kit } = await harness();
    const log = new RestartLog(kit.files, PATHS);
    await log.record({ session: 'alpha', at: '2030-01-08T09:20:00.000Z', endedAt: '2030-01-08T09:21:00.000Z', result: { kind: 'cleared' } });
    await log.record({ session: 'bravo', at: '2030-01-08T09:30:00.000Z', endedAt: '2030-01-08T09:31:00.000Z', result: { kind: 'cancelled', why: 'the user typed' } });
    await kit.files.append(join(PATHS.refresh, 'restarts.jsonl'), '{"session": "bravo", "endedAt": \n');
    assert.deepEqual(await stalledLines(kit), [
      'from the stalled-restart check [refresh.autoRestart]: RESTART-STALLED app/bravo has sat 20 min with its handover ready since 09:30 UTC and no restart pending or parked, past refresh.restartDelaySeconds (15 s) plus 10 min; last restart-log row: cancelled at 09:31 UTC (the user typed); type /clear in its tab for its fresh start',
    ]);
  });

  it('says so when the restart log has no row of the session', async () => {
    const { kit } = await harness();
    const [line] = await stalledLines(kit);
    assert.match(line ?? '', /; last restart-log row: none; type \/clear/);
  });

  it('counts the quiet from the ready state when the transcript cannot be read', async () => {
    const { kit } = await harness(ON, { ...READY, transcript: null });
    const [line] = await stalledLines(kit);
    assert.match(line ?? '', /has sat 30 min with its handover ready since 09:30 UTC/);
  });

  it('counts the quiet from the ready state too on a host whose transcript teamrig cannot read', async () => {
    const bare: HostSource = bareHost;
    const { kit } = await harness();
    const [line] = await stalledLines(kit, bare);
    assert.match(line ?? '', /has sat 30 min with its handover ready since 09:30 UTC/);
  });

  it('flags nothing inside the margin: quiet 9 min', async () => {
    const { kit } = await harness(ON, READY, '2030-01-08T09:51:00.000Z');
    assert.deepEqual(await stalledLines(kit), []);
  });

  it('flags nothing while a restart is pending or parked', async () => {
    const pending = await harness();
    await pending.store.setRestart('bravo', { phase: 'pending', at: READY.at, pid: 4242, ...TAB });
    assert.deepEqual(await stalledLines(pending.kit), []);
    const parked = await harness();
    await parked.store.setParked('bravo', { at: READY.at, ...TAB });
    assert.deepEqual(await stalledLines(parked.kit), []);
  });

  it('flags nothing for a session not yet noticed, one just restarted, or one still in a turn', async () => {
    assert.deepEqual(await stalledLines((await harness(ON, { ...READY, noticed: false })).kit), []);
    assert.deepEqual(await stalledLines((await harness(ON, { phase: 'refreshed', task: 'T4', at: READY.at })).kit), []);
    const working = await harness();
    await working.kit.files.write(TRANSCRIPT, `${JSON.stringify({ type: 'user', timestamp: '2030-01-08T09:40:00.000Z', message: { role: 'user', content: 'go on' } })}\n`);
    assert.deepEqual(await stalledLines(working.kit), []);
  });

  it('flags nothing for a session whose Claude Code is gone, its tab closed or its pid taken by another program', async () => {
    const closed = await harness();
    closed.kit.sessionProcesses.exit(4242);
    assert.deepEqual(await stalledLines(closed.kit), []);
    const reused = await harness();
    reused.kit.sessionProcesses.add({ pid: 4242, parentPid: 4000, name: 'node.exe', commandLine: 'node server.js' });
    assert.deepEqual(await stalledLines(reused.kit), []);
  });

  it('still flags a session whose ready state recorded no Claude Code process, as it cannot tell its tab is gone', async () => {
    const { kit } = await harness(ON, { ...READY, claudePid: null });
    assert.equal((await stalledLines(kit)).length, 1);
  });

  it('flags nothing for a session the automatic restart does not cover: a member while it is on for the lead only', async () => {
    const { kit } = await harness({ ...TEAM, refresh: { autoRestart: 'lead' } });
    assert.deepEqual(await stalledLines(kit), []);
  });

  it("is in the guide's list of check warnings", () => {
    const guide = readFileSync(new URL('../../plugins/teamrig/skills/teamrig-guide/commands.md', import.meta.url), 'utf8').replaceAll(/\s+/g, ' ');
    for (const words of ['RESTART-STALLED: a session', 'with its handover ready and noticed', 'no restart pending or parked', 'plus 10 minutes', 'its Claude Code still running', 'its last row in the restart log']) {
      assert.ok(guide.includes(words), words);
    }
  });
});
