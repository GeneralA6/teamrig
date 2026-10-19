import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { promptLine, textLine, transcript } from '../testing/transcript-lines.ts';
import { parseEntry, type TurnLogEntry } from '../turn-log/entry.ts';
import { EXIT } from './runtime.ts';

const AT = '2030-01-08T09:50:00.000Z';
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const LOG = join(TEAM_HOME, 'state', 'turn-log');
/** The harness's clock is 2030-01-08 10:00 UTC. */
const NOW_FILE = join(LOG, 'alpha', '2030-01-08T10.jsonl');
const ALPHA = { TEAMRIG_SESSION: 'alpha' };

/** Secret-shaped strings are assembled at runtime so none sits in the source. */
const secret = (...parts: string[]) => parts.join('');

function payload(event: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, ...fields });
}

function entriesOf(kit: CliHarness, path = NOW_FILE): TurnLogEntry[] {
  return (kit.files.get(path) ?? '').split('\n').flatMap((line) => {
    const record = parseObject(line.trim());
    const entry = record === undefined ? undefined : parseEntry(record);
    return entry === undefined ? [] : [entry];
  });
}

describe('turn log hooks', () => {
  it("logs the session's prompt with secret shapes redacted, then each part of a turn's reply once", async () => {
    const kit = new CliHarness(TEAM);
    const typed = secret('deploy with password', '=', 'hunter2 now');
    assert.equal((await kit.run(['hook', 'inbox-reminder'], { stdin: payload('UserPromptSubmit', { prompt: typed }), env: ALPHA })).code, EXIT.ok);
    await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, typed), textLine('a1', ['Part one.'])]));
    await kit.run(['hook', 'stop'], { stdin: payload('Stop', { last_assistant_message: 'Part one.' }), env: ALPHA });
    // A stop the refresh sent back: the turn goes on, and the next stop logs only what came after.
    await kit.files.append(TRANSCRIPT, transcript([textLine('a2', ['Part two.'])]));
    await kit.run(['hook', 'stop'], { stdin: payload('Stop', { stop_hook_active: true, last_assistant_message: 'Part two.' }), env: ALPHA });
    assert.deepEqual(
      entriesOf(kit).map(({ kind, text, upTo }) => ({ kind, text, upTo })),
      [
        { kind: 'prompt', text: 'deploy with [redacted password or key assignment] now', upTo: undefined },
        { kind: 'reply', text: 'Part one.', upTo: 'a1' },
        { kind: 'reply', text: 'Part two.', upTo: 'a2' },
      ],
    );
    assert.ok(entriesOf(kit).every((entry) => entry.claude === CLAUDE_SESSION && entry.at === '2030-01-08T10:00:00.000Z'));
  });

  it('logs the message Claude Code gives the stop when the transcript does not hold it yet', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, 'fix the build'), textLine('a1', ['Looking.'], ['t1'])]));
    await kit.run(['hook', 'stop'], { stdin: payload('Stop', { last_assistant_message: 'Fixed.' }), env: ALPHA });
    assert.deepEqual(
      entriesOf(kit).map(({ kind, text }) => ({ kind, text })),
      [{ kind: 'reply', text: 'Looking.\n\nFixed.' }],
    );
  });

  it('marks a /clear at the next start and removes the hours past turnLog.keepHours, for every session', async () => {
    const kit = new CliHarness({ ...TEAM, turnLog: { keepHours: 2 } });
    const old = join(LOG, 'bravo', '2030-01-08T07.jsonl');
    const kept = join(LOG, 'bravo', '2030-01-08T08.jsonl');
    await kit.files.write(old, '{}\n');
    await kit.files.write(kept, '{}\n');
    assert.equal((await kit.run(['hook', 'session-start'], { stdin: payload('SessionStart', { source: 'clear' }), env: ALPHA })).code, EXIT.ok);
    assert.deepEqual(
      entriesOf(kit).map(({ kind, text }) => ({ kind, text })),
      [{ kind: 'clear', text: 'context cleared (/clear)' }],
    );
    assert.equal(kit.files.get(old), undefined);
    assert.equal(kit.files.get(kept), '{}\n');
    await kit.run(['hook', 'session-start'], { stdin: payload('SessionStart', { source: 'resume' }), env: ALPHA });
    assert.equal(entriesOf(kit).length, 1);
  });

  it("leaves each hook's answer as it was when the log cannot be written", async () => {
    const answers = async (kit: CliHarness, files: Files): Promise<readonly { readonly code: number; readonly stdout: readonly string[] }[]> => {
      await kit.files.write(TRANSCRIPT, transcript([promptLine(AT, 'go'), textLine('a1', ['Done.'])]));
      const runs = [
        await kit.run(['hook', 'inbox-reminder'], { stdin: payload('UserPromptSubmit', { prompt: 'go' }), env: ALPHA, files }),
        await kit.run(['hook', 'stop'], { stdin: payload('Stop'), env: ALPHA, files }),
        await kit.run(['hook', 'session-start'], { stdin: payload('SessionStart', { source: 'clear' }), env: ALPHA, files }),
      ];
      return runs.map(({ code, stdout }) => ({ code, stdout }));
    };
    const healthy = new CliHarness(TEAM);
    const full = new CliHarness(TEAM);
    const faulty = new FaultyFiles(full.files).fail('append', NOW_FILE, systemError('ENOSPC', 'ENOSPC: no space left on device'));
    assert.deepEqual(await answers(full, faulty), await answers(healthy, healthy.files));
    assert.equal(full.files.get(NOW_FILE), undefined);
    assert.equal(entriesOf(healthy).length, 3);
  });

  it('writes nothing with turnLog off, or in a tab that is no team session', async () => {
    const off = new CliHarness({ ...TEAM, turnLog: { enabled: false } });
    await off.files.write(TRANSCRIPT, transcript([promptLine(AT), textLine('a1', ['Done.'])]));
    await off.run(['hook', 'inbox-reminder'], { stdin: payload('UserPromptSubmit', { prompt: 'go' }), env: ALPHA });
    await off.run(['hook', 'stop'], { stdin: payload('Stop'), env: ALPHA });
    await off.run(['hook', 'session-start'], { stdin: payload('SessionStart', { source: 'clear' }), env: ALPHA });
    const unbound = new CliHarness(TEAM);
    await unbound.files.write(TRANSCRIPT, transcript([promptLine(AT), textLine('a1', ['Done.'])]));
    await unbound.run(['hook', 'inbox-reminder'], { stdin: payload('UserPromptSubmit', { prompt: 'go' }) });
    await unbound.run(['hook', 'stop'], { stdin: payload('Stop') });
    for (const kit of [off, unbound]) {
      assert.deepEqual(kit.files.paths().filter((path) => path.includes('/turn-log/')), []);
    }
  });
});
