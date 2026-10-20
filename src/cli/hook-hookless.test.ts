import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { HOOKLESS_CHECK_MS, HOOKLESS_MS, parseHooklessState } from '../restore/hookless.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { EXIT } from './runtime.ts';

const ROLES_TEAM: JsonRecord = { ...TEAM, roles: { lead: 'lead', coordinatorOwner: 'bravo' } };
const STATE = join(TEAM_HOME, 'state', 'hookless.json');
const TAB = '0123abcd-0000-4000-8000-0000000000b1';
const TAB_TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${TAB}.jsonl`);
const STOP = JSON.stringify({ hook_event_name: 'Stop', session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: false });

/** A tab's restore entry: session `session` of team app, its hooks' last write `hookAgo` before the harness's clock. */
async function writeTab(kit: CliHarness, session: string, hookAgo: number, team = 'app'): Promise<void> {
  const at = kit.clock.now() - hookAgo;
  const entry: RestoreEntry = {
    claudeSession: TAB,
    projectDir: APP,
    transcriptPath: TAB_TRANSCRIPT,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 7000,
    team,
    session,
    state: 'working',
    createdAt: at,
    updatedAt: at,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
  };
  await new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).write(entry);
}

/** A turn's end in session `session`'s tab, its transcripts `transcripts`; the hook must print nothing and end well. */
async function stop(kit: CliHarness, transcripts: MemoryTranscripts, session = 'alpha'): Promise<void> {
  const result = await kit.run(['hook', 'stop'], { stdin: STOP, env: { TEAMRIG_SESSION: session }, transcripts });
  assert.deepEqual([result.code, result.stdout], [EXIT.ok, []]);
}

/** The lines of a session's inbox the check posted, without their date. */
function hooklessLines(kit: CliHarness, id: string): string[] {
  const text = kit.files.get(join(TEAM_HOME, 'state', 'inbox', `${id}.md`)) ?? '';
  return text.split('\n').flatMap((line) => {
    const at = line.indexOf(' teamrig: HOOKLESS ');
    return at < 0 ? [] : [line.slice(at + ' teamrig: '.length)];
  });
}

describe('the Stop hook checks for tabs that run without their hooks', () => {
  it('tells the lead once of a team tab whose transcript moves long past its last hook, and checks again after HOOKLESS_CHECK_MS', async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'alpha', 2 * HOOKLESS_MS);
    const transcripts = new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, kit.clock.now() - MS_PER_MINUTE);
    await stop(kit, transcripts, 'bravo');
    assert.deepEqual(hooklessLines(kit, 'lead'), [
      'HOOKLESS alpha: its tab (Claude session 0123abcd) worked 59 min past its last teamrig hook (hook 09:00 UTC, transcript 09:59 UTC), ' +
        'so it gets no inbox, guards or tab status: type /reload-plugins in that tab',
    ]);
    assert.deepEqual(parseHooklessState(kit.files.get(STATE) ?? ''), { checkedAt: kit.clock.now(), told: [TAB] });

    kit.clock.advance(HOOKLESS_CHECK_MS);
    transcripts.set(TAB_TRANSCRIPT, 'more', kit.clock.now());
    await stop(kit, transcripts, 'bravo');
    assert.equal(hooklessLines(kit, 'lead').length, 1, 'a tab still hookless is named once');
    assert.equal(parseHooklessState(kit.files.get(STATE) ?? '')?.checkedAt, kit.clock.now());
  });

  it("tells the coordinator's owner of the lead's own tab", async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'lead', 2 * HOOKLESS_MS);
    await stop(kit, new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, kit.clock.now()));
    assert.deepEqual(hooklessLines(kit, 'lead'), []);
    assert.equal(hooklessLines(kit, 'bravo').length, 1);
  });

  it("names no idle tab, no tab whose hooks wrote lately and no other team's, and checks no sooner than HOOKLESS_CHECK_MS", async () => {
    const idle = new CliHarness(ROLES_TEAM);
    await writeTab(idle, 'alpha', 2 * HOOKLESS_MS);
    await stop(idle, new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, idle.clock.now() - HOOKLESS_MS - MS_PER_MINUTE));
    const fresh = new CliHarness(ROLES_TEAM);
    await writeTab(fresh, 'alpha', 5 * MS_PER_MINUTE);
    await stop(fresh, new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, fresh.clock.now()));
    const other = new CliHarness(ROLES_TEAM);
    await writeTab(other, 'alpha', 2 * HOOKLESS_MS, 'web');
    await stop(other, new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, other.clock.now()));
    for (const kit of [idle, fresh, other]) {
      assert.deepEqual(hooklessLines(kit, 'lead'), []);
    }

    const soon = new CliHarness(ROLES_TEAM);
    const transcripts = new MemoryTranscripts({ [TAB_TRANSCRIPT]: '' }, soon.clock.now());
    await stop(soon, transcripts);
    await writeTab(soon, 'alpha', 2 * HOOKLESS_MS);
    soon.clock.advance(HOOKLESS_CHECK_MS - 1);
    transcripts.set(TAB_TRANSCRIPT, '', soon.clock.now());
    await stop(soon, transcripts);
    assert.deepEqual(hooklessLines(soon, 'lead'), [], 'the check before ran under HOOKLESS_CHECK_MS ago');
    soon.clock.advance(1);
    await stop(soon, transcripts);
    assert.equal(hooklessLines(soon, 'lead').length, 1);
  });
});
