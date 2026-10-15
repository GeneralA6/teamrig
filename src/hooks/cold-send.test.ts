import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FaultyFiles } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  COLD_SEND_TAIL_BYTES,
  coldSendReason,
  decideColdSend,
  holdOutput,
  isCold,
  JsonlColdSendLog,
  RESEND_WINDOW_MS,
  sendTargetOf,
  type ColdSendFacts,
} from './cold-send.ts';

const LOG = join('/', 'state', 'cold-sends.jsonl');
const TAB = '0123abcd-0000-4000-8000-00000000000a';
const OTHER_TAB = '0123abcd-0000-4000-8000-00000000000b';
const NOW = new Date('2030-01-08T10:00:00Z');
const HOUR = 3_600_000;

function factsAt(now: Date, overrides: Partial<ColdSendFacts> = {}): ColdSendFacts {
  return { claudeSession: TAB, to: 'alpha', name: 'app-alpha', idleMs: 2 * HOUR, coldAfterMinutes: 60, now, command: 'teamrig', ...overrides };
}

describe('sendTargetOf', () => {
  it("reads a SendMessage call's receiver", () => {
    assert.equal(sendTargetOf({ tool_name: 'SendMessage', tool_input: { to: ' app-alpha ', message: 'x' } }), 'app-alpha');
    assert.equal(sendTargetOf({ tool_name: 'SendMessage', tool_input: { to: 'app-alpha [uds:4f2a]' } }), 'app-alpha');
  });

  it('ignores other tools and calls naming no receiver', () => {
    assert.equal(sendTargetOf({ tool_name: 'Bash', tool_input: { to: 'app-alpha' } }), undefined);
    assert.equal(sendTargetOf({ tool_name: 'SendMessage', tool_input: { to: ' ' } }), undefined);
    assert.equal(sendTargetOf({ tool_name: 'SendMessage', tool_input: 'app-alpha' }), undefined);
    assert.equal(sendTargetOf({ tool_name: 'SendMessage' }), undefined);
    assert.equal(sendTargetOf('SendMessage'), undefined);
  });
});

describe('isCold', () => {
  it('counts a session idle the configured minutes or longer as cold', () => {
    assert.equal(isCold(60 * 60_000, 60), true);
    assert.equal(isCold(60 * 60_000 - 1, 60), false);
  });

  it('never counts a session as cold under 0 minutes', () => {
    assert.equal(isCold(100 * HOUR, 0), false);
  });
});

describe('decideColdSend', () => {
  it('sends to a warm session and writes nothing', async () => {
    const files = new MemoryFiles();
    const verdict = await decideColdSend(new JsonlColdSendLog(files, LOG), factsAt(NOW, { idleMs: 59 * 60_000 }));
    assert.deepEqual(verdict, { kind: 'send' });
    assert.equal(await files.read(LOG), undefined);
  });

  it("holds a cold session's first send, then lets the tab's next send within the window go", async () => {
    const log = new JsonlColdSendLog(new MemoryFiles(), LOG);
    const first = await decideColdSend(log, factsAt(NOW));
    assert.equal(first.kind, 'hold');
    const repeat = await decideColdSend(log, factsAt(new Date(NOW.getTime() + RESEND_WINDOW_MS)));
    assert.deepEqual(repeat, { kind: 'send' });
  });

  it('holds again once the window has passed, and holds each tab and receiver on its own', async () => {
    const log = new JsonlColdSendLog(new MemoryFiles(), LOG);
    await decideColdSend(log, factsAt(NOW));
    assert.equal((await decideColdSend(log, factsAt(new Date(NOW.getTime() + RESEND_WINDOW_MS + 1)))).kind, 'hold');
    assert.equal((await decideColdSend(log, factsAt(NOW, { claudeSession: OTHER_TAB }))).kind, 'hold');
    assert.equal((await decideColdSend(log, factsAt(NOW, { to: 'bravo', name: 'app-bravo' }))).kind, 'hold');
  });

  it('sends when the hold log cannot be read or written, so no message is held for good', async () => {
    const unreadable = new FaultyFiles(new MemoryFiles()).fail('readTail', LOG, new Error('disk gone'));
    assert.deepEqual(await decideColdSend(new JsonlColdSendLog(unreadable, LOG), factsAt(NOW)), { kind: 'send' });
    const unwritable = new FaultyFiles(new MemoryFiles()).fail('append', LOG, new Error('disk full'));
    assert.deepEqual(await decideColdSend(new JsonlColdSendLog(unwritable, LOG), factsAt(NOW)), { kind: 'send' });
  });
});

describe('JsonlColdSendLog', () => {
  it('skips damaged lines and reads only the tail of a long log', async () => {
    const files = new MemoryFiles({ [LOG]: `not json\n${'x'.repeat(COLD_SEND_TAIL_BYTES)}\n` });
    const log = new JsonlColdSendLog(files, LOG);
    assert.equal(await log.heldSince(TAB, 'alpha', new Date(0)), false);
    await log.record(TAB, 'alpha', NOW);
    assert.equal(await log.heldSince(TAB, 'alpha', NOW), true);
    assert.equal(await log.heldSince(TAB, 'alpha', new Date(NOW.getTime() + 1)), false);
  });
});

describe('the hold note', () => {
  it('names the idle time, the inbox command and the resend window', () => {
    const reason = coldSendReason(factsAt(NOW, { idleMs: 94 * 60_000 + 59_000 }));
    assert.match(reason, /^Held once: app-alpha has been idle 94 min, so this message would wake it cold/);
    assert.ok(reason.includes('teamrig inbox add --to alpha --text "..."'));
    assert.ok(reason.includes('send it again: a send to it within 15 min goes through.'));
  });

  it('is a PreToolUse refusal carrying the note', () => {
    assert.deepEqual(JSON.parse(holdOutput('why')), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' },
    });
  });
});
