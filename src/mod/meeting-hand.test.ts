import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEETING_RECHECK_MS,
  MEETING_TICK_MS,
  MeetingHand,
  TOAST_MAX_MS,
  meetingCliArgv,
  parseMeetingDueAnswer,
  type MeetingDueAnswer,
  type MeetingHandHost,
  type MeetingRun,
} from './meeting-hand.ts';

const TAB = '0123abcd-0000-4000-8000-0000000000a1';
const MEETINGS = '/kit/teams/app/state/meetings.jsonl';
const AT = 1_060_000;
const NOTICE = { id: 'M1', stage: 'start', title: 'teamrig meeting M1 now', text: 'alpha: the release plan (30 min). Start: teamrig meeting start M1', stayMs: null };
const MISSED = { id: 'M2', stage: 'missed', title: 'teamrig meeting M2 missed', text: 'alpha: the release plan has not started. Start: teamrig meeting start M2, or move or drop it', stayMs: 86_400_000 };
const WAIT: MeetingDueAnswer = { kind: 'due', notices: [], watch: [MEETINGS], recheckAt: AT };
const SENT: MeetingDueAnswer = { kind: 'due', notices: [NOTICE], watch: [MEETINGS], recheckAt: null };

function run(answer: MeetingDueAnswer): MeetingRun {
  return { exitCode: 0, stdout: `${JSON.stringify(answer)}\n` };
}

/** Claude Code as the mod sees it: the tab, the CLI's answers in turn (the last repeats), and the meetings file. */
class FakeHost implements MeetingHandHost {
  time = 1_000_000;
  answers: MeetingRun[] = [run(WAIT)];
  changed: number | undefined = 5;
  readonly calls: { readonly stdin: unknown; readonly env: Readonly<Record<string, string>>; readonly cwd: string }[] = [];
  readonly toasts: { readonly text: string; readonly stayMs: number | null }[] = [];

  async sessionId(): Promise<string> {
    return TAB;
  }

  async cwd(): Promise<string> {
    return '/work/app/src';
  }

  async root(): Promise<string> {
    return '/work/app';
  }

  async cli(stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<MeetingRun> {
    this.calls.push({ stdin: JSON.parse(stdin), env, cwd });
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    assert.ok(next !== undefined, 'the test set an answer');
    return next;
  }

  async changedAt(path: string): Promise<number | undefined> {
    assert.equal(path, MEETINGS);
    return this.changed;
  }

  toast(text: string, stayMs: number | null): void {
    this.toasts.push({ text, stayMs });
  }

  now(): number {
    return this.time;
  }
}

/** A hand past its first two asks: the CLI named the meetings file and its change time is taken. */
async function settled(host: FakeHost): Promise<MeetingHand> {
  const hand = new MeetingHand(host);
  assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: AT });
  assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: AT });
  assert.deepEqual(await hand.tick(), { kind: 'quiet' });
  return hand;
}

describe('meetingCliArgv', () => {
  it("runs the plugin's CLI as hook meeting-due", () => {
    assert.deepEqual(meetingCliArgv('/plugins/teamrig'), ['node', '/plugins/teamrig/dist/cli/main.js', 'hook', 'meeting-due']);
  });
});

describe('parseMeetingDueAnswer', () => {
  it('reads each answer the CLI gives', () => {
    assert.deepEqual(parseMeetingDueAnswer(JSON.stringify(SENT)), SENT);
    assert.deepEqual(parseMeetingDueAnswer('{"kind":"off","why":"not in a team"}'), { kind: 'off', why: 'not in a team' });
  });

  it('takes nothing else', () => {
    assert.equal(parseMeetingDueAnswer('not json'), undefined);
    assert.equal(parseMeetingDueAnswer('{"kind":"due","notices":[{"id":"M1"}],"watch":[],"recheckAt":null}'), undefined);
    assert.equal(parseMeetingDueAnswer('{"kind":"due","notices":[],"watch":[],"recheckAt":"soon"}'), undefined);
    assert.equal(parseMeetingDueAnswer('[]'), undefined);
    assert.equal(parseMeetingDueAnswer(JSON.stringify({ ...SENT, notices: [{ ...NOTICE, stayMs: 'long' }] })), undefined);
    assert.equal(parseMeetingDueAnswer(JSON.stringify({ ...SENT, notices: [{ ...NOTICE, stayMs: 0 }] })), undefined);
    assert.equal(parseMeetingDueAnswer(JSON.stringify({ ...SENT, notices: [{ ...NOTICE, stage: 3 }] })), undefined);
  });

  it("reads an older CLI's notice, with no stage or stay, as one at the slot that keeps the default time", () => {
    const old = { kind: 'due', notices: [{ id: 'M1', title: NOTICE.title, text: NOTICE.text }], watch: [], recheckAt: null };
    assert.deepEqual(parseMeetingDueAnswer(JSON.stringify(old)), { ...old, notices: [NOTICE] });
  });
});

describe('MeetingHand', () => {
  it('asks the CLI as the tab, then only once the meetings file changed', async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    assert.deepEqual(host.calls[0], { stdin: { session_id: TAB, cwd: '/work/app/src' }, env: { CLAUDE_CODE_SESSION_ID: TAB, CLAUDE_PROJECT_DIR: '/work/app' }, cwd: '/work/app/src' });
    host.changed = 6;
    assert.deepEqual(await hand.tick(), { kind: 'waiting', recheckAt: AT });
    assert.equal(host.calls.length, 3);
  });

  it("asks at the meeting's time, and shows each notice the CLI sent as a toast", async () => {
    const host = new FakeHost();
    const hand = await settled(host);
    host.answers = [run(SENT)];
    host.time = AT - 1;
    assert.deepEqual(await hand.tick(), { kind: 'quiet' });
    host.time = AT;
    assert.deepEqual(await hand.tick(), { kind: 'notified', ids: ['M1'] });
    assert.deepEqual(host.toasts, [{ text: `${NOTICE.title}: ${NOTICE.text}`, stayMs: null }]);
    assert.deepEqual(await hand.tick(), { kind: 'quiet' }, 'with no time named, it waits for a change');
    host.time = AT + MEETING_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'notified', ids: ['M1'] }, 'or MEETING_RECHECK_MS on');
  });

  it("keeps a missed meeting's toast up for the time the CLI named, at most the engine's longest", async () => {
    const host = new FakeHost();
    const shortStay = { ...MISSED, id: 'M3', stayMs: 30_000 };
    host.answers = [run({ kind: 'due', notices: [MISSED, shortStay], watch: [MEETINGS], recheckAt: null })];
    const hand = new MeetingHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'notified', ids: ['M2', 'M3'] });
    const text = `${MISSED.title}: ${MISSED.text}`;
    assert.deepEqual(host.toasts, [{ text, stayMs: TOAST_MAX_MS }, { text, stayMs: 30_000 }]);
    assert.equal(TOAST_MAX_MS, 60_000);
  });

  it('looks every 30 s, and goes on while a turn runs: it tracks no turns', () => {
    assert.equal(MEETING_TICK_MS, 30_000);
    assert.equal('turnStarted' in MeetingHand.prototype, false);
  });

  it('reports a CLI that is off, fails or answers what it cannot read, and never rejects', async () => {
    const host = new FakeHost();
    host.answers = [run({ kind: 'off', why: 'this tab is not a team session' })];
    const hand = new MeetingHand(host);
    assert.deepEqual(await hand.tick(), { kind: 'off', why: 'this tab is not a team session' });
    host.answers = [{ exitCode: 1, stdout: 'boom' }];
    host.time += MEETING_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'hook meeting-due exited 1: boom' });
    host.cli = async () => {
      throw new Error('node is missing');
    };
    host.time += MEETING_RECHECK_MS;
    assert.deepEqual(await hand.tick(), { kind: 'failed', error: 'node is missing' });
  });

  it('skips a tick while the one before still runs', async () => {
    const host = new FakeHost();
    let release: (() => void) | undefined;
    host.cli = () =>
      new Promise((resolve) => {
        release = () => resolve(run(WAIT));
      });
    const hand = new MeetingHand(host);
    const first = hand.tick();
    await Promise.resolve();
    assert.deepEqual(await hand.tick(), { kind: 'overlap' });
    while (release === undefined) {
      await Promise.resolve();
    }
    release();
    assert.deepEqual(await first, { kind: 'waiting', recheckAt: AT });
  });
});
