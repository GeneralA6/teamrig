import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, formatEntry, parseEntry, TOOL_END_WRITE_MS, type RestoreEntry, type TrackEvent, type TrackFacts } from './entry.ts';

const ID = '0123abcd-0000-4000-8000-00000000000a';
const T0 = Date.parse('2030-01-08T09:00:00Z');
const T1 = Date.parse('2030-01-08T10:00:00Z');
const MAIN_TOOL: TrackEvent = { kind: 'tool', mainThread: true };

function facts(overrides: Partial<TrackFacts> = {}): TrackFacts {
  return {
    claudeSession: ID,
    at: T1,
    projectDir: '/work/app',
    transcriptPath: '/u/.claude/projects/app/x.jsonl',
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 7000,
    team: undefined,
    session: undefined,
    ...overrides,
  };
}

const ENTRY: RestoreEntry = {
  claudeSession: ID,
  projectDir: '/work/first',
  transcriptPath: '/u/.claude/projects/app/x.jsonl',
  entrypoint: 'cli',
  sessionKind: undefined,
  pid: 6000,
  team: 'app',
  session: 'alpha',
  state: 'working',
  createdAt: T0,
  updatedAt: T0,
  restoreAttempts: 1,
  restoredAt: T0,
  endedAt: undefined,
  endReason: undefined,
};

function written(change: ReturnType<typeof applyEvent>): RestoreEntry {
  assert.equal(change.kind, 'write');
  return change.kind === 'write' ? change.entry : ENTRY;
}

describe('applyEvent', () => {
  it('starts an entry at a first event, with the folder it names', () => {
    const entry = written(applyEvent(undefined, { kind: 'working' }, facts()));
    assert.equal(entry.projectDir, '/work/app');
    assert.equal(entry.state, 'working');
    assert.equal(entry.createdAt, T1);
    assert.equal(entry.restoreAttempts, 0);
  });

  it('writes nothing for a first event that names no folder', () => {
    assert.deepEqual(applyEvent(undefined, { kind: 'ready' }, facts({ projectDir: undefined })), { kind: 'none' });
  });

  it('keeps the first folder and fills the facts an event leaves out from the entry', () => {
    const entry = written(applyEvent(ENTRY, { kind: 'ready' }, facts({ pid: undefined, transcriptPath: undefined })));
    assert.equal(entry.projectDir, '/work/first');
    assert.equal(entry.pid, 6000);
    assert.equal(entry.team, 'app');
    assert.equal(entry.state, 'ready');
    assert.equal(entry.updatedAt, T1);
    assert.equal(entry.createdAt, T0);
  });

  it('records an API error as its state', () => {
    assert.equal(written(applyEvent(ENTRY, { kind: 'error', code: 'overloaded' }, facts())).state, 'error');
  });

  it("records a failed turn's error and keeps its retry count until a good turn end or a start", () => {
    const failed = written(applyEvent(ENTRY, { kind: 'error', code: 'server_error' }, facts()));
    assert.deepEqual(failed.apiError, { code: 'server_error', failedAt: T1, retries: 0, retriedAt: undefined });
    const retried: RestoreEntry = { ...failed, apiError: { code: 'server_error', failedAt: T1, retries: 1, retriedAt: T1 + 60_000 } };
    const prompted = written(applyEvent(retried, { kind: 'working' }, facts({ at: T1 + 61_000 })));
    assert.deepEqual(prompted.apiError, retried.apiError, "a retry's own prompt keeps the count");
    const again = written(applyEvent(prompted, { kind: 'error', code: 'overloaded' }, facts({ at: T1 + 90_000 })));
    assert.deepEqual(again.apiError, { code: 'overloaded', failedAt: T1 + 90_000, retries: 1, retriedAt: T1 + 60_000 });
    assert.deepEqual(written(applyEvent(again, MAIN_TOOL, facts({ at: T1 + TOOL_END_WRITE_MS * 2 }))).apiError, again.apiError);
    assert.deepEqual(written(applyEvent(again, { kind: 'end', reason: 'other' }, facts())).apiError, again.apiError);
    assert.equal('apiError' in written(applyEvent(again, { kind: 'ready' }, facts())), false);
    assert.equal('apiError' in written(applyEvent(again, { kind: 'start' }, facts())), false);
  });

  it('begins a start afresh: ready, with no restore pending', () => {
    const entry = written(applyEvent(ENTRY, { kind: 'start' }, facts()));
    assert.equal(entry.state, 'ready');
    assert.equal(entry.restoreAttempts, 0);
    assert.equal(entry.restoredAt, undefined);
  });

  it('removes the entry at an end the person or Claude Code chose', () => {
    for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit']) {
      assert.deepEqual(applyEvent(ENTRY, { kind: 'end', reason }, facts()), { kind: 'remove' });
    }
  });

  it('records any other end, and one with no reason as other', () => {
    const closed = written(applyEvent(ENTRY, { kind: 'end', reason: undefined }, facts()));
    assert.equal(closed.endedAt, T1);
    assert.equal(closed.endReason, 'other');
    assert.equal(written(applyEvent(ENTRY, { kind: 'end', reason: 'bypass_permissions_disabled' }, facts())).endReason, 'bypass_permissions_disabled');
  });

  it('clears an end once a later event shows the session runs again', () => {
    const ended = written(applyEvent(ENTRY, { kind: 'end', reason: 'other' }, facts()));
    const again = written(applyEvent(ended, { kind: 'working' }, facts({ at: T1 + 1000 })));
    assert.equal(again.endedAt, undefined);
    assert.equal(again.endReason, undefined);
  });

  it("marks a main-thread tool's end working, writing only once TOOL_END_WRITE_MS passed since the last write", () => {
    const ready: RestoreEntry = { ...ENTRY, state: 'ready', updatedAt: T1 };
    assert.deepEqual(applyEvent(ready, MAIN_TOOL, facts({ at: T1 + TOOL_END_WRITE_MS - 1 })), { kind: 'none' });
    const later = written(applyEvent(ready, MAIN_TOOL, facts({ at: T1 + TOOL_END_WRITE_MS })));
    assert.deepEqual([later.state, later.updatedAt], ['working', T1 + TOOL_END_WRITE_MS]);
  });

  it("keeps the state at a helper's tool end, which can come after its session's turn ended", () => {
    const ready: RestoreEntry = { ...ENTRY, state: 'ready', updatedAt: T1 };
    const later = written(applyEvent(ready, { kind: 'tool', mainThread: false }, facts({ at: T1 + TOOL_END_WRITE_MS })));
    assert.deepEqual([later.state, later.updatedAt], ['ready', T1 + TOOL_END_WRITE_MS]);
  });

  it("writes a tool's end at once for a session with no entry or an ended one", () => {
    assert.equal(written(applyEvent(undefined, MAIN_TOOL, facts())).state, 'working');
    const ended = written(applyEvent(ENTRY, { kind: 'end', reason: 'other' }, facts()));
    assert.equal(written(applyEvent(ended, MAIN_TOOL, facts({ at: T1 + 1000 }))).endedAt, undefined);
  });
});

describe('formatEntry and parseEntry', () => {
  it('round-trips an entry, its times as ISO instants', () => {
    const text = formatEntry(ENTRY);
    assert.match(text, /"createdAt": "2030-01-08T09:00:00.000Z"/);
    assert.doesNotMatch(text, /endedAt/);
    assert.deepEqual(parseEntry(text), ENTRY);
  });

  it('refuses a damaged entry or one of another shape', () => {
    const record = JSON.parse(formatEntry(ENTRY));
    assert.equal(parseEntry('{"claudeSe'), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, claudeSession: '../x' })), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, state: 'asleep' })), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, updatedAt: 'soon' })), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, pid: -1 })), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, team: 'A Team; rm' })), undefined);
    assert.equal(parseEntry(JSON.stringify({ ...record, restoreAttempts: undefined })), undefined);
  });

  it("round-trips a failed turn's state, and reads an entry written before it as one with none", () => {
    const failed: RestoreEntry = { ...ENTRY, state: 'error', apiError: { code: 'server_error', failedAt: T0, retries: 2, retriedAt: T1 } };
    const text = formatEntry(failed);
    assert.match(text, /"failedAt": "2030-01-08T09:00:00.000Z"/);
    assert.deepEqual(parseEntry(text), failed);
    const unnamed: RestoreEntry = { ...ENTRY, apiError: { code: undefined, failedAt: T0, retries: 0, retriedAt: undefined } };
    assert.deepEqual(parseEntry(formatEntry(unnamed)), unnamed);
    assert.equal('apiError' in (parseEntry(formatEntry(ENTRY)) ?? failed), false);
  });

  it("keeps an entry whose failed turn's state is damaged, losing only that state", () => {
    const record = JSON.parse(formatEntry(ENTRY));
    const damaged = [{ failedAt: 'soon', retries: 0 }, { failedAt: '2030-01-08T09:00:00Z', retries: -1 }, { failedAt: '2030-01-08T09:00:00Z', retries: 0, code: 7 }, { failedAt: '2030-01-08T09:00:00Z', retries: 0, retriedAt: 'later' }, 'x'];
    for (const apiError of damaged) {
      assert.deepEqual(parseEntry(JSON.stringify({ ...record, apiError })), ENTRY, JSON.stringify(apiError));
    }
  });
});
