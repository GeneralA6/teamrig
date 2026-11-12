import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEETING_PANEL_RECHECK_MS,
  MEETING_PANEL_TICK_MS,
  MeetingPanelHand,
  meetingPanelCliArgv,
  panelRows,
  parseMeetingPanelAnswer,
  type MeetingPanelAnswer,
  type MeetingPanelHost,
  type MeetingPanelRun,
  type MeetingPanelView,
} from './meeting-panel-hand.ts';

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const MEETING = '/kit/teams/alpha/state/meeting.json';
const EVENTS = '/kit/teams/alpha/register/events.jsonl';
const STARTED = '2026-11-12T10:00:00.000Z';
const VIEW: MeetingPanelView = {
  startedAt: STARTED,
  items: [
    { id: 'T1', title: 'Pick the release day', settled: true, decision: 'Tuesday' },
    { id: 'bravo/T2', title: 'Raise the budget', settled: false, decision: null },
    { id: 'T3', title: 'Name the product', settled: false, decision: null },
  ],
  current: 'bravo/T2',
  left: 2,
};
const OPEN: MeetingPanelAnswer = { kind: 'open', watch: [MEETING, EVENTS], ...VIEW };
const NONE: MeetingPanelAnswer = { kind: 'off', why: 'no meeting is open', watch: [MEETING] };

function run(answer: MeetingPanelAnswer): MeetingPanelRun {
  return { exitCode: 0, stdout: `${JSON.stringify(answer)}\n` };
}

/** Claude Code as the mod sees it: the tab, the CLI's answers in turn (the last repeats), the watched files, the pane. */
class FakeHost implements MeetingPanelHost {
  time = 1_000_000;
  answers: MeetingPanelRun[] = [run(OPEN)];
  readonly changes = new Map<string, number>([
    [MEETING, 5],
    [EVENTS, 7],
  ]);
  readonly calls: { readonly stdin: unknown; readonly env: Readonly<Record<string, string>>; readonly cwd: string }[] = [];
  /** What the pane saw, in order: opened, closed, or the panel handed to its drawing. */
  readonly pane: (string | MeetingPanelView | null)[] = [];

  async sessionId(): Promise<string> {
    return TAB;
  }

  async cwd(): Promise<string> {
    return '/work/app/src';
  }

  async root(): Promise<string> {
    return '/work/app';
  }

  async cli(stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<MeetingPanelRun> {
    this.calls.push({ stdin: JSON.parse(stdin), env, cwd });
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    assert.ok(next !== undefined, 'the test set an answer');
    return next;
  }

  async changedAt(path: string): Promise<number | undefined> {
    return this.changes.get(path);
  }

  async open(): Promise<void> {
    this.pane.push('open');
  }

  async close(): Promise<void> {
    this.pane.push('close');
  }

  async show(view: MeetingPanelView | null): Promise<void> {
    this.pane.push(view);
  }

  now(): number {
    return this.time;
  }
}

/** A hand past its first two asks (the second takes the named files' change times), then quiet. */
async function settled(host: FakeHost): Promise<MeetingPanelHand> {
  const hand = new MeetingPanelHand(host);
  await hand.tick();
  await hand.tick();
  assert.deepEqual(await hand.tick(), { kind: 'quiet' });
  return hand;
}

describe('meetingPanelCliArgv', () => {
  it("runs the plugin's CLI as hook meeting-panel", () => {
    assert.deepEqual(meetingPanelCliArgv('/plugins/teamrig'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'meeting-panel']);
  });
});

describe('parseMeetingPanelAnswer', () => {
  it('reads each answer the CLI gives', () => {
    assert.deepEqual(parseMeetingPanelAnswer(JSON.stringify(OPEN)), OPEN);
    assert.deepEqual(parseMeetingPanelAnswer(JSON.stringify(NONE)), NONE);
    const done = { ...OPEN, current: null, left: 0 };
    assert.deepEqual(parseMeetingPanelAnswer(JSON.stringify(done)), done);
  });

  it('takes nothing else', () => {
    assert.equal(parseMeetingPanelAnswer('not json'), undefined);
    assert.equal(parseMeetingPanelAnswer('[]'), undefined);
    assert.equal(parseMeetingPanelAnswer('{"kind":"off","why":"x"}'), undefined, 'no watch list');
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, items: [{ id: 'T1', title: 'x', settled: 'yes', decision: null }] })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, items: [{ id: 'T1', title: 'x', settled: true, decision: 3 }] })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, items: [7] })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, items: 'none' })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, left: -1 })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, current: 4 })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, startedAt: 1 })), undefined);
    assert.equal(parseMeetingPanelAnswer(JSON.stringify({ ...OPEN, kind: 'shut' })), undefined);
  });
});

describe('panelRows', () => {
  it('checks off each decided card with its decision, marks the one on the table, then lists the rest', () => {
    assert.deepEqual(panelRows(VIEW), [
      { text: '2 to decide', mark: 'asked' },
      { text: '✓ T1 Pick the release day: Tuesday', mark: 'done' },
      { text: '▶ bravo/T2 Raise the budget', mark: 'current' },
      { text: '· T3 Name the product', mark: 'asked' },
    ]);
  });

  it('draws a card decided with no note, and says when every card is decided', () => {
    const done: MeetingPanelView = { startedAt: STARTED, items: [{ id: 'T1', title: 'Pick the release day', settled: true, decision: null }], current: null, left: 0 };
    assert.deepEqual(panelRows(done), [
      { text: 'Every card decided', mark: 'asked' },
      { text: '✓ T1 Pick the release day', mark: 'done' },
    ]);
  });
});

describe('MeetingPanelHand', () => {
  it('asks the CLI as the tab, opens the pane once for an open meeting, and redraws on each change', async () => {
    const host = new FakeHost();
    const hand = new MeetingPanelHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
    assert.deepEqual(host.calls[0], { stdin: { session_id: TAB, cwd: '/work/app/src' }, env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' }, cwd: '/work/app/src' });
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    assert.deepEqual(host.pane, [VIEW, 'open', VIEW]);
    const next = { ...OPEN, items: VIEW.items.map((item) => (item.id === 'bravo/T2' ? { ...item, settled: true, decision: 'No' } : item)), current: 'T3', left: 1 };
    host.answers = [run(next)];
    host.changes.set(EVENTS, 8);
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'T3', left: 1 });
    assert.equal(host.pane.filter((seen) => seen === 'open').length, 1, 'the pane opened once');
    assert.equal(host.calls.length, 3);
  });

  it('closes the pane it opened once the meeting ends, and opens it for the next one', async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    host.answers = [run(NONE)];
    host.changes.set(MEETING, 6);
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'no meeting is open', closed: true });
    assert.deepEqual(host.pane.slice(-2), ['close', null]);
    host.time += MEETING_PANEL_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'no meeting is open', closed: false }, 'a closed pane is not closed again');
    host.answers = [run({ ...OPEN, startedAt: '2026-11-13T10:00:00.000Z' })];
    host.changes.set(MEETING, 7);
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
    assert.equal(host.pane.at(-1), 'open');
  });

  it('closes a pane a module loaded before it left up, at its first answer of no panel', async () => {
    const host = new FakeHost();
    host.answers = [run(NONE)];
    const hand = new MeetingPanelHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'no meeting is open', closed: true });
    assert.deepEqual(host.pane, ['close', null]);
  });

  it("keeps the pane closed after the person's close until another meeting starts", async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    hand.personClosed();
    host.changes.set(EVENTS, 8);
    assert.deepEqual(await hand.tick(), { kind: 'dismissed' });
    host.answers = [run(NONE)];
    host.changes.set(MEETING, 6);
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'no meeting is open', closed: false }, 'the person closed it already');
    host.answers = [run({ ...OPEN, startedAt: '2026-11-13T10:00:00.000Z' })];
    host.changes.set(MEETING, 7);
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
    assert.equal(host.pane.at(-1), 'open');
  });

  it('a close before any pane opened only stops nothing', async () => {
    const host = new FakeHost();
    const hand = new MeetingPanelHand(host);
    hand.personClosed();
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
  });

  it('looks every 15 s and asks again after 10 minutes with no change', async () => {
    assert.equal(MEETING_PANEL_TICK_MS, 15_000);
    const host = new FakeHost();
    const hand = await settled(host);
    host.time += MEETING_PANEL_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'shown', current: 'bravo/T2', left: 2 });
    assert.equal(host.calls.length, 3);
  });

  it('reports a CLI that fails or answers what it cannot read, and never rejects', async () => {
    const host = new FakeHost();
    host.answers = [{ exitCode: 1, stdout: 'boom' }];
    const hand = new MeetingPanelHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook meeting-panel exited 1: boom' });
    host.answers = [{ exitCode: 0, stdout: 'not json' }];
    host.time += MEETING_PANEL_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook meeting-panel exited 0: not json' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    host.time += MEETING_PANEL_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'node is missing' });
    host.cli = async () => {
      throw 'gone';
    };
    host.time += MEETING_PANEL_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'gone' });
  });

  it('skips a tick while the one before still runs', async () => {
    const host = new FakeHost();
    let release: (() => void) | undefined;
    host.cli = () =>
      new Promise((resolve) => {
        release = () => resolve(run(OPEN));
      });
    const hand = new MeetingPanelHand(host);
    const first = hand.tick();
    await Promise.resolve();
    assert.deepEqual(await hand.tick(), { kind: 'overlap' });
    while (release === undefined) {
      await Promise.resolve();
    }
    release();
    assert.deepEqual(await first, { kind: 'shown', current: 'bravo/T2', left: 2 });
  });
});
