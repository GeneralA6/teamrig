import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { homeCloseOf, SessionLog, type CloseRecord } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CliHarness, decisionOf, reasonOf, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { WakeAsks } from '../wake/asks.ts';

const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'idle-pass', at: '2030-01-08T08:00:00.000Z', claudeSession: ALPHA_TAB, idleMinutes: 75, freedMb: 1300 };

function send(to: string, message = 'Review the fix on T1.'): string {
  return JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'SendMessage', tool_input: { to, message } });
}

/** A team in idle mode `mode` whose alpha the idle pass closed, and whose lead reads its inbox in the sending tab. */
async function closedAlpha(mode: string, extra: JsonRecord = {}): Promise<CliHarness> {
  const config: JsonRecord = { ...TEAM, open: { idle: { mode } }, ...extra };
  const kit = new CliHarness(config);
  await new SessionLog(kit.files, join(TEAM_HOME, 'state', 'session-log.jsonl')).append(CLOSED);
  const read = await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
  assert.equal(read.code, 0, read.stderr.join('\n'));
  return kit;
}

function coldSend(kit: CliHarness, stdin: string, files: Files = kit.files): Promise<CliResult> {
  return kit.run(['hook', 'cold-send'], { stdin, files });
}

async function asksOf(kit: CliHarness): Promise<number> {
  return (await new WakeAsks(kit.files, ASKS).read('alpha')).length;
}

describe('a send to a session teamrig closed', () => {
  it("posts the message as the receiver's urgent line and denies the send with why, while the idle pass reopens sessions", async () => {
    const kit = await closedAlpha('on');
    // A record from before the close is the tab the close ended.
    await new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('alpha', { claudePid: 42, claudeSession: ALPHA_TAB, at: '2030-01-08T07:00:00.000Z' });
    const held = await coldSend(kit, send('app-alpha'));
    assert.equal(held.code, 0, held.stderr.join('\n'));
    assert.equal(decisionOf(held), 'deny');
    assert.match(
      reasonOf(held) ?? '',
      /^app-alpha is closed \(idle-pass closed it at \d\d:\d\d \S+\), so this message cannot reach it; teamrig posted it as an urgent line in its inbox, and the idle pass reopens it within about a minute with the line quoted in its first prompt\. Do not send it again\. Next time post it yourself: teamrig inbox add --to alpha --text "\.\.\." --wake now\.$/,
    );
    assert.deepEqual((await new WakeAsks(kit.files, ASKS).read('alpha')).map((stored) => stored.ask), [{ from: 'lead', text: 'Review the fix on T1.', at: kit.clock.now() }]);
    const inbox = await kit.run(['inbox', 'read', '--session', 'alpha']);
    assert.match(inbox.stdout.join('\n'), /lead: Review the fix on T1\./);
  });

  it('lets the send go when no pass reopens, the receiver is not closed or was started by hand since, the tab is its own, or there is no text', async () => {
    for (const mode of ['off', 'dry-run']) {
      const kit = await closedAlpha(mode);
      assert.deepEqual((await coldSend(kit, send('alpha'))).stdout, [], mode);
      assert.equal(await asksOf(kit), 0, mode);
    }

    const open = new CliHarness({ ...TEAM, open: { idle: { mode: 'on' } } });
    assert.deepEqual((await coldSend(open, send('alpha'))).stdout, [], 'never closed');

    const byHand = await closedAlpha('on');
    await new SessionRecordStore(byHand.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('alpha', { claudePid: 43, claudeSession: ALPHA_TAB, at: '2030-01-08T09:00:00.000Z' });
    assert.deepEqual((await coldSend(byHand, send('alpha'))).stdout, [], 'started by hand since its close');

    const own = await closedAlpha('on');
    await own.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.deepEqual((await coldSend(own, send('alpha'))).stdout, [], "the sender's own session");

    const silent = await closedAlpha('on');
    assert.deepEqual((await coldSend(silent, send('alpha', ' '))).stdout, [], 'an idle subscription');
    for (const kit of [open, byHand, own, silent]) {
      assert.equal(await asksOf(kit), 0);
    }
  });

  it('says a session hired home with no room was hired so, not closed (T1364)', async () => {
    const kit = new CliHarness({ ...TEAM, open: { idle: { mode: 'on' } } });
    await new SessionLog(kit.files, join(TEAM_HOME, 'state', 'session-log.jsonl')).append(homeCloseOf('alpha', 'lead', '2030-01-08T08:00:00.000Z'));
    const read = await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION } });
    assert.equal(read.code, 0, read.stderr.join('\n'));
    const held = await coldSend(kit, send('alpha'));
    assert.equal(decisionOf(held), 'deny');
    assert.match(reasonOf(held) ?? '', /^app-alpha is home \(lead hired it at \d\d:\d\d \S+ with no room on the host\), so this message cannot reach it; teamrig posted it as an urgent line/);
    assert.equal(await asksOf(kit), 1);
  });

  it('denies with why when the urgent line cannot be posted, and how to leave it instead', async () => {
    const kit = await closedAlpha('on');
    const files = new FaultyFiles(kit.files).fail('createExclusive', join(ASKS, 'alpha', `${kit.clock.now()}-0.json`), systemError('EACCES', 'EACCES: permission denied'));
    const held = await coldSend(kit, send('alpha'), files);
    assert.equal(decisionOf(held), 'deny');
    assert.match(
      reasonOf(held) ?? '',
      /^app-alpha is closed \(.*\), so this message cannot reach it, and teamrig could not post it as an urgent line: posted to the inbox, but it does not wake alpha: EACCES: permission denied\. Tell the lead the urgent line failed; unless that says it is in the inbox, leave it with teamrig inbox add --to alpha --text "\.\.\." --wake now once that is fixed\.$/,
    );
  });

  it('names no --wake now on a team with wakes off', async () => {
    const kit = await closedAlpha('on', { wake: { enabled: false } });
    const held = await coldSend(kit, send('alpha'));
    assert.equal(decisionOf(held), 'deny');
    assert.match(reasonOf(held) ?? '', /Do not send it again\.$/);
  });
});
