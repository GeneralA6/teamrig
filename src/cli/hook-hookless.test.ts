import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { HOOKLESS_CHECK_MS, HOOKLESS_MS, HOOKLESS_TAIL_BYTES, parseHooklessState } from '../restore/hookless.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine, systemLine, transcript } from '../testing/transcript-lines.ts';
import { EXIT } from './runtime.ts';

const ROLES_TEAM: JsonRecord = { ...TEAM, roles: { lead: 'lead', coordinatorOwner: 'bravo' } };
const STATE = join(TEAM_HOME, 'state', 'hookless.json');
const TAB = '0123abcd-0000-4000-8000-0000000000b1';
const TAB_TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${TAB}.jsonl`);
const STOP = JSON.stringify({ hook_event_name: 'Stop', session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: false });
const RELOAD = '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>';
const NO_HOOKS = 'so it gets no inbox, guards or tab status';

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

function isoAgo(kit: CliHarness, ago: number): string {
  return new Date(kit.clock.now() - ago).toISOString();
}

/** A main-thread reply, `ago` before the harness's clock. */
function reply(kit: CliHarness, ago: number): string {
  return replyLine({ at: isoAgo(kit, ago), usage: { output: 1 } });
}

/** A /reload-plugins, typed or run by the reload hand, `ago` before the harness's clock. */
function reload(kit: CliHarness, ago: number): string {
  return promptLine(isoAgo(kit, ago), RELOAD);
}

/** The tab's transcript of `lines`, its file last changed `changedAgo` before the harness's clock. */
function tabTranscript(kit: CliHarness, lines: readonly string[], changedAgo = 0): MemoryTranscripts {
  return new MemoryTranscripts({ [TAB_TRANSCRIPT]: transcript(lines) }, kit.clock.now() - changedAgo);
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
  it('tells the lead once of a team tab whose last reply came long past its last hook, and checks again after HOOKLESS_CHECK_MS', async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'alpha', 2 * HOOKLESS_MS);
    const transcripts = tabTranscript(kit, [reply(kit, MS_PER_MINUTE)], MS_PER_MINUTE);
    await stop(kit, transcripts, 'bravo');
    assert.deepEqual(hooklessLines(kit, 'lead'), [
      `HOOKLESS alpha: its tab (Claude session 0123abcd) worked 59 min past its last teamrig hook (hook 09:00 UTC, last reply 09:59 UTC), ${NO_HOOKS}: ` +
        'type /reload-plugins in that tab',
    ]);
    assert.deepEqual(parseHooklessState(kit.files.get(STATE) ?? ''), { checkedAt: kit.clock.now(), told: [TAB] });

    kit.clock.advance(HOOKLESS_CHECK_MS);
    transcripts.append(TAB_TRANSCRIPT, transcript([reply(kit, 0)]), kit.clock.now());
    await stop(kit, transcripts, 'bravo');
    assert.equal(hooklessLines(kit, 'lead').length, 1, 'a tab still hookless is named once');
    assert.equal(parseHooklessState(kit.files.get(STATE) ?? '')?.checkedAt, kit.clock.now());
  });

  it("tells the coordinator's owner of the lead's own tab", async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'lead', 2 * HOOKLESS_MS);
    await stop(kit, tabTranscript(kit, [reply(kit, 0)]));
    assert.deepEqual(hooklessLines(kit, 'lead'), []);
    assert.equal(hooklessLines(kit, 'bravo').length, 1);
  });

  it('names no idle tab whose transcript moves with no turn, as with /reload-plugins and Claude Code notes (T1055)', async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'alpha', 2 * HOOKLESS_MS);
    const lines = [reply(kit, 2 * HOOKLESS_MS), reload(kit, 20 * MS_PER_MINUTE), systemLine(isoAgo(kit, 20 * MS_PER_MINUTE)), reload(kit, MS_PER_MINUTE)];
    await stop(kit, tabTranscript(kit, lines), 'bravo');
    assert.deepEqual(hooklessLines(kit, 'lead'), []);
    assert.deepEqual(parseHooklessState(kit.files.get(STATE) ?? ''), { checkedAt: kit.clock.now(), told: [] });
  });

  it('waits for the next reply after a reload, and then asks for a restart, not another reload', async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'alpha', 2 * HOOKLESS_MS);
    const transcripts = tabTranscript(kit, [reply(kit, 10 * MS_PER_MINUTE), reload(kit, 5 * MS_PER_MINUTE)]);
    await stop(kit, transcripts, 'bravo');
    assert.deepEqual(hooklessLines(kit, 'lead'), [], 'the reload may have brought the hooks back');

    kit.clock.advance(HOOKLESS_CHECK_MS);
    transcripts.append(TAB_TRANSCRIPT, transcript([reply(kit, MS_PER_MINUTE)]), kit.clock.now());
    await stop(kit, transcripts, 'bravo');
    assert.deepEqual(hooklessLines(kit, 'lead'), [
      `HOOKLESS alpha: its tab (Claude session 0123abcd) worked 69 min past its last teamrig hook (hook 09:00 UTC, last reply 10:09 UTC), ${NO_HOOKS}: ` +
        `the /reload-plugins at 09:55 UTC did not bring them back: /exit that tab and run claude --resume ${TAB} in its folder`,
    ]);
  });

  it('reads only the end of a long transcript', async () => {
    const kit = new CliHarness(ROLES_TEAM);
    await writeTab(kit, 'alpha', 2 * HOOKLESS_MS);
    const long = JSON.stringify({ type: 'system', subtype: 'informational', content: 'x'.repeat(HOOKLESS_TAIL_BYTES), timestamp: isoAgo(kit, HOOKLESS_MS) });
    const transcripts = tabTranscript(kit, [long, reply(kit, 0)]);
    await stop(kit, transcripts, 'bravo');
    assert.equal(hooklessLines(kit, 'lead').length, 1);
    assert.equal(transcripts.bytesRead, HOOKLESS_TAIL_BYTES);
  });

  it("names no tab whose file stopped, no tab whose hooks wrote lately and no other team's, and checks no sooner than HOOKLESS_CHECK_MS", async () => {
    const idle = new CliHarness(ROLES_TEAM);
    await writeTab(idle, 'alpha', 2 * HOOKLESS_MS);
    const stopped = tabTranscript(idle, [reply(idle, HOOKLESS_MS + MS_PER_MINUTE)], HOOKLESS_MS + MS_PER_MINUTE);
    await stop(idle, stopped);
    assert.equal(stopped.bytesRead, 0, 'a file that did not move lately is not read');
    const fresh = new CliHarness(ROLES_TEAM);
    await writeTab(fresh, 'alpha', 5 * MS_PER_MINUTE);
    await stop(fresh, tabTranscript(fresh, [reply(fresh, 0)]));
    const other = new CliHarness(ROLES_TEAM);
    await writeTab(other, 'alpha', 2 * HOOKLESS_MS, 'web');
    await stop(other, tabTranscript(other, [reply(other, 0)]));
    const retired = new CliHarness(ROLES_TEAM);
    await writeTab(retired, 'charlie', 2 * HOOKLESS_MS);
    await stop(retired, tabTranscript(retired, [reply(retired, 0)]));
    for (const kit of [idle, fresh, other, retired]) {
      assert.deepEqual(hooklessLines(kit, 'lead'), []);
    }

    const soon = new CliHarness(ROLES_TEAM);
    const transcripts = tabTranscript(soon, [reply(soon, 0)]);
    await stop(soon, transcripts);
    await writeTab(soon, 'alpha', 2 * HOOKLESS_MS);
    soon.clock.advance(HOOKLESS_CHECK_MS - 1);
    transcripts.append(TAB_TRANSCRIPT, transcript([reply(soon, 0)]), soon.clock.now());
    await stop(soon, transcripts);
    assert.deepEqual(hooklessLines(soon, 'lead'), [], 'the check before ran under HOOKLESS_CHECK_MS ago');
    soon.clock.advance(1);
    await stop(soon, transcripts);
    assert.equal(hooklessLines(soon, 'lead').length, 1);
  });
});
