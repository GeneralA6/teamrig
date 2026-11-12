import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from '../register/events.ts';
import { foldEvents } from '../register/fold.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { cursorAfter, DIGEST_MAX_LINES, DigestCursorStore, digestLines, formatDigestCursor, parseDigestCursor, WITHHELD_NOTE, type DigestCursor } from './leader-digest.ts';

const fields = (owner: string, title = 'Ship it'): TaskFields => ({
  title,
  description: null,
  owner,
  source: 'lead',
  ref: null,
  priority: 2,
  due: null,
  goals: [],
  noGoal: false,
  week: null,
  after: [],
  size: null,
  type: null,
  critical: false,
  pin: null,
  workClass: null,
});

const at = (minute: number): string => new Date(Date.UTC(2030, 0, 8, 10, minute)).toISOString();

function create(id: string, minute: number, by: string, owner = by, title = `Task ${id}`): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id, at: at(minute), by, task: fields(owner, title) };
}

function status(id: string, minute: number, by: string, value: 'in-progress' | 'done' | 'open', note: string | null = null): RegisterEvent {
  return { v: EVENT_VERSION, type: 'status', id, at: at(minute), by, status: value, note, evidence: null, skill: null };
}

function note(id: string, minute: number, by: string, text: string): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id, at: at(minute), by, changes: {}, note: text };
}

function digest(events: readonly RegisterEvent[], since: DigestCursor, tree: readonly string[] = ['lead', 'alpha', 'bravo'], leader = 'lead', isSecret = (text: string) => text.includes('hunter2')): string[] {
  return digestLines({ events, tasks: foldEvents(events).tasks, since, leader, tree: new Set(tree), isSecret });
}

describe('digestLines', () => {
  const before = [create('T1', 0, 'alpha'), create('T2', 1, 'bravo')];
  const cursor: DigestCursor = { at: at(1), seen: 1 };

  it('is empty when nothing changed after the cursor', () => {
    assert.deepEqual(digest(before, cursor), []);
  });

  it('gives a heading and one line per task: the status change and the newest note, newest task first', () => {
    const events = [...before, status('T1', 2, 'alpha', 'in-progress', 'started'), note('T2', 3, 'bravo', 'found the cause'), note('T1', 4, 'alpha', 'wave 1 landed'), create('T3', 5, 'alpha')];
    assert.deepEqual(digest(events, cursor), [
      'teamrig: register changes in your tree since your last prompt (3 tasks):',
      '- T3 new -> open: Task T3',
      '- T1 open -> in-progress: wave 1 landed',
      '- T2 open: found the cause',
    ]);
  });

  it('shows no status change when the task ends where it started, and no note when none was written', () => {
    const events = [...before, status('T1', 2, 'alpha', 'in-progress'), status('T1', 3, 'alpha', 'open')];
    assert.deepEqual(digest(events, cursor).slice(1), ['- T1 open']);
  });

  it("leaves out the leader's own writes and tasks outside its tree", () => {
    const events = [...before, create('T3', 2, 'charlie'), note('T1', 3, 'lead', 'looked at it'), status('T2', 4, 'bravo', 'in-progress', 'started')];
    assert.deepEqual(digest(events, cursor).slice(1), ['- T2 open -> in-progress: started']);
    assert.deepEqual(digest(events, cursor, ['alpha', 'bravo'], 'alpha').slice(1), ['- T2 open -> in-progress: started', '- T1 open: looked at it'], "a sub-lead sees the lead's note on its member's task");
  });

  it('keeps the note of another session when the leader wrote the newest one', () => {
    const events = [...before, note('T1', 2, 'alpha', 'from alpha'), note('T1', 3, 'lead', 'from the lead')];
    assert.deepEqual(digest(events, cursor).slice(1), ['- T1 open: from alpha']);
  });

  it('collapses whitespace and cuts a long note to 80 characters', () => {
    const events = [...before, note('T1', 2, 'alpha', `first\n\n  second ${'y'.repeat(100)}`)];
    const [line] = digest(events, cursor).slice(1);
    assert.equal(line, `- T1 open: ${`first second ${'y'.repeat(100)}`.slice(0, 77)}...`);
  });

  it('withholds a note or a new title that matches a secret shape, keeping the status change', () => {
    const events = [...before, status('T1', 2, 'alpha', 'in-progress', 'the key is hunter2'), create('T3', 3, 'alpha', 'alpha', 'Rotate hunter2')];
    assert.deepEqual(digest(events, cursor).slice(1), [`- T3 new -> open: ${WITHHELD_NOTE}`, `- T1 open -> in-progress: ${WITHHELD_NOTE}`]);
    assert.ok(!digest(events, cursor).join('\n').includes('hunter2'));
  });

  it(`caps the lines at ${DIGEST_MAX_LINES} and counts the rest`, () => {
    const events = Array.from({ length: DIGEST_MAX_LINES + 3 }, (_, index) => create(`T${index + 1}`, index + 2, 'alpha'));
    const lines = digest(events, { at: at(0), seen: 0 });
    assert.equal(lines.length, DIGEST_MAX_LINES + 2);
    assert.equal(lines[1], `- T${DIGEST_MAX_LINES + 3} new -> open: Task T${DIGEST_MAX_LINES + 3}`);
    assert.equal(lines.at(-1), '...(+3 more: teamrig list)');
  });

  it('shows an event written at the instant of the cursor past the ones it had seen', () => {
    const events = [...before, note('T2', 1, 'bravo', 'same instant')];
    assert.deepEqual(digest(events, cursor).slice(1), ['- T2 open: same instant']);
    assert.deepEqual(digest(events, { at: at(1), seen: 2 }), []);
  });
});

describe('cursorAfter', () => {
  it('stands at the newest event, counting every event at its instant', () => {
    assert.equal(cursorAfter([]), undefined);
    assert.deepEqual(cursorAfter([create('T1', 3, 'alpha'), create('T2', 5, 'alpha'), note('T1', 5, 'alpha', 'x'), note('T2', 4, 'alpha', 'y')]), { at: at(5), seen: 2 });
  });
});

describe('the digest cursor file', () => {
  it('round-trips, and reads a damaged or other-format file as no cursor', async () => {
    assert.deepEqual(parseDigestCursor(formatDigestCursor({ at: at(1), seen: 3 })), { at: at(1), seen: 3 });
    for (const text of ['', 'not json', '{"v":2,"at":"2030-01-08T10:00:00.000Z","seen":0}', '{"v":1,"at":"soon","seen":0}', '{"v":1,"at":"2030-01-08T10:00:00.000Z","seen":-1}']) {
      assert.equal(parseDigestCursor(text), undefined, text);
    }
    const store = new DigestCursorStore(new MemoryFiles(), '/state/leader-digest');
    assert.equal(await store.read('lead'), undefined);
    await store.write('lead', { at: at(2), seen: 1 });
    assert.deepEqual(await store.read('lead'), { at: at(2), seen: 1 });
  });
});
