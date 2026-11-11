import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFRESH } from '../config/defaults.ts';
import {
  boundaryOf,
  decideCompact,
  decideMidTurn,
  decideReady,
  decideStart,
  decideStop,
  handoverHashOf,
  noticeOf,
  REASK_SHARE,
  reaskGrowth,
  SMALLEST_MODEL_WINDOW,
  thousands,
  type AskContext,
  type DueFacts,
  type MidTurnFacts,
  type RefreshSettings,
  type StopContext,
  type StopFacts,
  wakePromptOf,
  WAKE_WINDOW_MS,
} from './decide.ts';
import type { RefreshState } from './state.ts';

const BEFORE = '2030-01-08T09:00:00.000Z';
const NOW = '2030-01-08T10:00:00.000Z';
const HANDOVER = '/team/handover/alpha.md';
const CAP = DEFAULT_REFRESH.handoverMaxBytes;

const BOUNDARY: RefreshState = { phase: 'boundary', task: 'T12', at: BEFORE, finished: 1, ask: null };
const ASKED: RefreshState = { phase: 'asked', task: 'T12', at: BEFORE, tokens: 262_144, handoverHash: null, midTurn: false };
/** Asked at a tool result at 131k; the handover file had the fingerprint `old` then. */
const MID_TURN: RefreshState = { phase: 'asked', task: null, at: BEFORE, tokens: 131_000, handoverHash: 'old', midTurn: true };
const READY: RefreshState = { phase: 'ready', task: 'T12', at: BEFORE, tokens: null, noticed: false, transcript: null, claudePid: null };
/** The size rule alone at 250k, so each size test reads apart from the task count. */
const SIZE_ONLY: RefreshSettings = { ...DEFAULT_REFRESH, contextTokens: 250_000, everyTasks: 0 };
const COUNTED: RefreshSettings = { ...SIZE_ONLY, everyTasks: 3, everyTasksMinTokens: 80_000 };
/** The size rule at 250k with room to 300k, the ceiling an open meeting holds a refresh up to. */
const ROOMY: RefreshSettings = { ...SIZE_ONLY, compactCeilingTokens: 300_000 };

function stopContext(overrides: Partial<StopContext> = {}): StopContext {
  return {
    stopHookActive: false,
    settings: SIZE_ONLY,
    now: NOW,
    session: { id: 'alpha', team: 'app', name: 'api' },
    handoverPath: HANDOVER,
    command: 'teamrig',
    canRestart: false,
    transcript: null,
    ...overrides,
  };
}

/** The facts flat, so a test names only the ones it sets. */
type FlatFacts = Omit<StopFacts, 'due'> & DueFacts;

/** Every fact read, the due ones too. */
function facts(overrides: Partial<FlatFacts> = {}): StopFacts {
  const flat: FlatFacts = { requestedBy: undefined, tokens: 120_000, meeting: false, handoverHash: null, running: 0, ...overrides };
  return { requestedBy: flat.requestedBy, tokens: flat.tokens, meeting: flat.meeting, due: { handoverHash: flat.handoverHash, running: flat.running } };
}

/** The facts every turn end reads, before the due ones. */
function cheap(overrides: Partial<FlatFacts> = {}): StopFacts {
  return { ...facts(overrides), due: undefined };
}

describe('decideStop', () => {
  it('does nothing with the feature off', () => {
    for (const state of [undefined, BOUNDARY, READY]) {
      assert.deepEqual(decideStop(state, stopContext({ settings: { ...DEFAULT_REFRESH, enabled: false } }), facts({ tokens: 900_000 })), { kind: 'none' }, state?.phase);
    }
  });

  it('reads the facts at every turn end, and the due ones only once a refresh or the notice is due', () => {
    for (const state of [undefined, BOUNDARY, READY, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (RefreshState | undefined)[]) {
      assert.deepEqual(decideStop(state, stopContext()), { kind: 'measure' }, state?.phase);
    }
    assert.deepEqual(decideStop(READY, stopContext(), cheap()), { kind: 'measure' }, 'the notice reads the running work');
    assert.deepEqual(decideStop(undefined, stopContext(), cheap({ tokens: 262_144 })), { kind: 'measure' }, 'a due refresh reads the handover');
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), cheap({ tokens: 262_144 })), { kind: 'measure' });
  });

  it('says nothing at a turn end under the threshold, nor after a notice', () => {
    for (const state of [
      undefined,
      { phase: 'idle', task: 'T12', at: BEFORE, tokens: 5, finished: 1 },
      ASKED,
      { phase: 'refreshed', task: 'T12', at: BEFORE },
      { ...READY, noticed: true },
    ] satisfies (RefreshState | undefined)[]) {
      assert.deepEqual(decideStop(state, stopContext(), cheap({ tokens: 249_999 })), { kind: 'none' }, state?.phase);
      assert.deepEqual(decideStop(state, stopContext(), cheap({ tokens: undefined })), { kind: 'none' }, `${state?.phase}, size unknown`);
    }
  });

  it('asks mid-task at any turn end at or over the threshold, naming no task', () => {
    const decision = decideStop(undefined, stopContext(), facts({ tokens: 262_144, handoverHash: 'abc' }));
    assert.deepEqual(decision, {
      kind: 'block',
      state: { phase: 'asked', task: null, at: NOW, tokens: 262_144, handoverHash: 'abc', midTurn: false },
      reason: 'teamrig: your context is 262k (refresh at 250k), so refresh now rather than at a task end. ' + 'Write your handover to /team/handover/alpha.md, replacing the whole file (your fresh start reads all of it): what the register lacks (the next step of each task in progress; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), not task statuses, which your fresh start reads live from the register. Then run `teamrig refresh --ready --session alpha`. Do not start new work.',
    });
    for (const state of [
      { phase: 'idle', task: 'T12', at: BEFORE, tokens: 120_000, finished: 1 },
      { phase: 'refreshed', task: 'T12', at: BEFORE },
      { ...READY, noticed: true },
    ] satisfies RefreshState[]) {
      const asked = decideStop(state, stopContext(), facts({ tokens: 250_000 }));
      assert.deepEqual(asked.kind === 'block' ? asked.state : undefined, { phase: 'asked', task: null, at: NOW, tokens: 250_000, handoverHash: null, midTurn: false }, state.phase);
    }
    assert.equal(decideStop(undefined, stopContext(), facts({ tokens: 262_144, running: 1 })).kind, 'block', 'asks while work runs');
  });

  it('asks mid-task once the lead asked, whatever the size', () => {
    const idle: RefreshState = { phase: 'idle', task: 'T12', at: BEFORE, tokens: 40_000, finished: 1 };
    const decision = decideStop(idle, stopContext(), facts({ requestedBy: 'boss', tokens: 40_400 }));
    assert.match(decision.kind === 'block' ? decision.reason : '', /^teamrig: boss asked for a refresh \(your context is 40k\), so refresh now rather than at a task end\. /);
  });

  it('asks again only once the context grew well past an ask the session went on from', () => {
    assert.equal(REASK_SHARE, 0.2);
    assert.equal(reaskGrowth(SIZE_ONLY), 50_000);
    const noticed: RefreshState = { ...READY, tokens: 262_144, noticed: true };
    for (const state of [ASKED, noticed]) {
      assert.deepEqual(decideStop(state, stopContext(), cheap({ tokens: 312_143 })), { kind: 'none' }, state.phase);
      assert.deepEqual(decideStop(state, stopContext(), cheap({ requestedBy: 'boss', tokens: 300_000 })), { kind: 'none' }, `${state.phase}: the lead's ask was asked`);
      const again = decideStop(state, stopContext(), facts({ tokens: 312_144 }));
      assert.deepEqual(again.kind === 'block' ? again.state : undefined, { phase: 'asked', task: null, at: NOW, tokens: 312_144, handoverHash: null, midTurn: false }, state.phase);
    }
    assert.equal(decideStop({ ...ASKED, tokens: null }, stopContext(), facts({ tokens: 250_000 })).kind, 'block', 'a size forgotten asks at the threshold');
    assert.equal(decideStop({ ...ASKED, tokens: 40_400 }, stopContext(), facts({ tokens: 250_000 })).kind, 'block', 'never past the threshold for a small ask');
  });

  it('asks again at the next task end, after the session went on from an ask', () => {
    const decision = decideStop(boundaryOf(ASKED, 'T13', NOW), stopContext(), facts({ tokens: 262_144 }));
    assert.match(decision.kind === 'block' ? decision.reason : '', /and you just finished T13\. /);
  });

  it('never judges a boundary in a turn a Stop hook already continued', () => {
    assert.deepEqual(decideStop(BOUNDARY, stopContext({ stopHookActive: true })), { kind: 'none' });
    assert.deepEqual(decideStop(BOUNDARY, stopContext({ stopHookActive: true }), facts({ tokens: 900_000 })), { kind: 'none' });
  });

  it('records a boundary under the threshold, or of unknown size, as judged and says nothing', () => {
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ tokens: 249_999 })), {
      kind: 'write',
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: 249_999, finished: 1 },
    });
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ tokens: undefined })), {
      kind: 'write',
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: null, finished: 1 },
    });
    assert.equal(decideStop(BOUNDARY, stopContext(), cheap({ tokens: 249_999 })).kind, 'write', 'without reading the due facts');
  });

  it('asks for the handover at or over the threshold, naming the size, the path and the ready command', () => {
    const decision = decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, handoverHash: 'abc' }));
    assert.deepEqual(decision, {
      kind: 'block',
      state: { phase: 'asked', task: 'T12', at: NOW, tokens: 262_144, handoverHash: 'abc', midTurn: false },
      reason:
        'teamrig: your context is 262k (refresh at 250k) and you just finished T12. Write your handover to /team/handover/alpha.md, replacing the whole file (your fresh start reads all of it): what the register lacks ' +
        '(the next step of each task in progress; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), ' +
        'not task statuses, which your fresh start reads live from the register. Then run `teamrig refresh --ready --session alpha`. Do not start new work.',
    });
    assert.equal(decideStop(BOUNDARY, stopContext(), facts({ tokens: 250_000 })).kind, 'block');
  });

  it('asks for the handover when the lead asked, whatever the size', () => {
    const small = decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', tokens: 40_400 }));
    assert.equal(small.kind, 'block');
    assert.match(small.kind === 'block' ? small.reason : '', /^teamrig: boss asked for a refresh \(your context is 40k\) and you just finished T12\. /);
    const unknown = decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', tokens: undefined }));
    assert.match(unknown.kind === 'block' ? unknown.reason : '', /^teamrig: boss asked for a refresh and you just finished T12\. /);
    assert.deepEqual(unknown.kind === 'block' ? unknown.state : undefined, { phase: 'asked', task: 'T12', at: NOW, tokens: null, handoverHash: null, midTurn: false });
  });

  it('asks while background work runs, naming it, so a session busy with background steps refreshes before Claude Code compacts it', () => {
    const one = decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, running: 1 }));
    assert.deepEqual(one.kind === 'block' ? one.state : undefined, { phase: 'asked', task: 'T12', at: NOW, tokens: 262_144, handoverHash: null, midTurn: false });
    assert.match(
      one.kind === 'block' ? one.reason : '',
      /from the register\. A background task you started still runs: say in the handover what its result still needs; the fresh start waits until it reports back\. Then run `teamrig refresh --ready --session alpha`\. Do not start new work\.$/,
    );
    const two = decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', running: 2 }));
    assert.match(two.kind === 'block' ? two.reason : '', /\. 2 background tasks you started still run: say in the handover what each result still needs; the fresh start waits until they report back\. Then run /);
    const none = decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, running: 0 }));
    assert.match(none.kind === 'block' ? none.reason : '', /from the register\. Then run `teamrig refresh --ready/, 'nothing running, no such line');
  });

  it('records a boundary with no refresh due as judged even while background work runs', () => {
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ tokens: 120_000, running: 3 })), {
      kind: 'write',
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: 120_000, finished: 1 },
    });
  });

  it('follows the threshold the team set', () => {
    const settings = { ...DEFAULT_REFRESH, contextTokens: 150_000 };
    const decision = decideStop(BOUNDARY, stopContext({ settings }), facts({ tokens: 150_000 }));
    assert.match(decision.kind === 'block' ? decision.reason : '', /your context is 150k \(refresh at 150k\)/);
  });

  it('asks for the handover after enough tasks, once the context is worth a fresh start', () => {
    const third: RefreshState = { ...BOUNDARY, finished: 3 };
    const decision = decideStop(third, stopContext({ settings: COUNTED }), facts({ tokens: 95_000 }));
    assert.equal(decision.kind, 'block');
    assert.match(
      decision.kind === 'block' ? decision.reason : '',
      /^teamrig: your context is 95k after 3 tasks \(refresh every 3 tasks\) and you just finished T12\. /,
    );
    assert.equal(decideStop({ ...BOUNDARY, finished: 5 }, stopContext({ settings: COUNTED }), facts({ tokens: 80_000 })).kind, 'block', 'past the count, at the floor');
    assert.deepEqual(decideStop({ ...BOUNDARY, finished: 2 }, stopContext({ settings: COUNTED }), facts({ tokens: 95_000 })), {
      kind: 'write',
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: 95_000, finished: 2 },
    });
    assert.equal(decideStop(third, stopContext({ settings: COUNTED }), facts({ tokens: 79_999 })).kind, 'write', 'under the floor');
    assert.equal(decideStop(third, stopContext({ settings: COUNTED }), facts({ tokens: undefined })).kind, 'write', 'size unknown');
    assert.equal(decideStop(third, stopContext({ settings: SIZE_ONLY }), facts({ tokens: 95_000 })).kind, 'write', 'count off');
    assert.equal(decideStop(third, stopContext({ settings: COUNTED }), facts({ tokens: 95_000, running: 1 })).kind, 'block', 'asks while work runs');
  });

  it('names the size when the size and the count are both due', () => {
    const settings: RefreshSettings = { ...COUNTED, contextTokens: 120_000 };
    const decision = decideStop({ ...BOUNDARY, finished: 4 }, stopContext({ settings }), facts({ tokens: 130_000 }));
    assert.match(decision.kind === 'block' ? decision.reason : '', /: your context is 130k \(refresh at 120k\) and/);
  });

  it('tells the user once that the handover is written, with the tab mark when the team wants it', () => {
    assert.deepEqual(decideStop(READY, stopContext(), facts()), {
      kind: 'notice',
      state: { ...READY, noticed: true },
      message: 'teamrig: api finished T12 and wrote its handover; type /clear for a fresh start',
      title: '[app] api: type /clear',
      restart: false,
    });
    const plain = decideStop(READY, stopContext({ settings: { ...DEFAULT_REFRESH, tabTitle: false } }), facts());
    assert.equal(plain.kind === 'notice' ? plain.title : 'other', undefined);
    assert.deepEqual(decideStop(READY, stopContext({ canRestart: true }), facts()), {
      kind: 'notice',
      state: { ...READY, noticed: true },
      message: 'teamrig: api finished T12 and wrote its handover; teamrig starts it fresh once it has been idle 15 s (type anything to keep this context)',
      title: '[app] api: restarting',
      restart: true,
    });
  });

  it('says a restart held back waits for a wake that brings work, keeping the context to whoever types (T1383)', () => {
    assert.deepEqual(noticeOf(READY, stopContext({ canRestart: true }), 'park'), {
      kind: 'notice',
      state: { ...READY, noticed: true },
      message: 'teamrig: api finished T12 and wrote its handover; it has no work it can start now, so teamrig starts it fresh once a wake brings it some (type anything to keep this context)',
      title: '[app] api: waits for work',
      restart: false,
    });
  });

  it('names no task in the notice of a refresh asked mid-task', () => {
    const decision = decideStop({ ...READY, task: null }, stopContext(), facts());
    assert.equal(decision.kind === 'notice' ? decision.message : '', 'teamrig: api wrote its handover; type /clear for a fresh start');
  });

  it("records the session's transcript with the notice, for the fresh start to read what it leaves", () => {
    const decision = decideStop(READY, stopContext({ transcript: '/claude/projects/p/s.jsonl' }), facts());
    assert.deepEqual(decision.kind === 'notice' ? decision.state : undefined, { ...READY, noticed: true, transcript: '/claude/projects/p/s.jsonl' });
  });

  it('gives the notice in the turn a Stop hook continued, since that turn runs refresh --ready', () => {
    assert.equal(decideStop(READY, stopContext({ stopHookActive: true }), facts()).kind, 'notice');
  });

  it('holds the notice while background work runs, so the user is not told to /clear over it', () => {
    assert.deepEqual(decideStop(READY, stopContext(), facts({ running: 1 })), { kind: 'none' });
    assert.equal(decideStop(READY, stopContext(), facts({ running: 0 })).kind, 'notice');
  });

  it('asks once more at the end of a turn a tool result asked in, keeping that ask for refresh --ready', () => {
    assert.deepEqual(decideStop(MID_TURN, stopContext()), { kind: 'measure' });
    assert.deepEqual(decideStop(MID_TURN, stopContext(), cheap()), { kind: 'measure' });
    const again = decideStop(MID_TURN, stopContext(), facts({ tokens: 140_000, handoverHash: 'new' }));
    assert.equal(again.kind, 'block');
    assert.deepEqual(again.kind === 'block' ? again.state : undefined, { ...MID_TURN, midTurn: false });
    const reason = again.kind === 'block' ? again.reason : '';
    assert.match(reason, /^teamrig: the refresh asked within this turn at 131k is still due, so refresh now rather than at a task end\. /);
    assert.match(reason, /Then run `teamrig refresh --ready --session alpha`\. Do not start new work\.$/);
  });

  it('asks the second time while background work runs, and never in a turn a Stop hook continued', () => {
    const again = decideStop(MID_TURN, stopContext(), facts({ running: 1 }));
    assert.match(again.kind === 'block' ? again.reason : '', /\. A background task you started still runs: .+ Then run /);
    assert.deepEqual(decideStop(MID_TURN, stopContext({ stopHookActive: true }), facts()), { kind: 'none' });
  });

  it('asks a session that went on after the second ask again at the threshold, as after any ask', () => {
    const answered: RefreshState = { ...MID_TURN, midTurn: false };
    assert.deepEqual(decideStop(answered, stopContext(), facts({ tokens: 249_999 })), { kind: 'none' });
    assert.equal(decideStop(answered, stopContext(), facts({ tokens: 250_000 })).kind, 'block');
  });

  describe('in an open meeting', () => {
    const roomy = stopContext({ settings: ROOMY, canRestart: true });

    it('never asks, without reading the running work, and asks at the first turn end after the meeting', () => {
      for (const state of [undefined, BOUNDARY]) {
        assert.deepEqual(decideStop(state, roomy, cheap({ tokens: 260_000, meeting: true })), { kind: 'none' }, state?.phase);
        assert.equal(decideStop(state, roomy, facts({ tokens: 260_000 })).kind, 'block', state?.phase);
      }
      assert.deepEqual(decideStop(undefined, roomy, cheap({ requestedBy: 'captain', meeting: true })), { kind: 'none' }, "the lead's request waits too");
    });

    it('still closes a finished task with no refresh due', () => {
      assert.equal(decideStop(BOUNDARY, roomy, cheap({ tokens: 100_000, meeting: true })).kind, 'write');
    });

    it('holds the second ask of a turn a tool result asked in', () => {
      assert.deepEqual(decideStop(MID_TURN, roomy, cheap({ tokens: 260_000, meeting: true })), { kind: 'none' });
      assert.equal(decideStop(MID_TURN, roomy, facts({ tokens: 260_000 })).kind, 'block');
    });

    it('holds the notice of a written handover, and so its restart, until the meeting ends', () => {
      assert.deepEqual(decideStop(READY, roomy), { kind: 'measure' });
      assert.deepEqual(decideStop(READY, roomy, cheap({ tokens: 260_000, meeting: true })), { kind: 'none' });
      assert.deepEqual(decideStop(READY, roomy, cheap({ tokens: undefined, meeting: true })), { kind: 'none' }, 'an untold size is held');
      const after = decideStop(READY, roomy, facts({ tokens: 260_000 }));
      assert.equal(after.kind === 'notice' ? after.restart : undefined, true);
    });

    it('lets the refresh go at the ceiling, so the session never runs out of room', () => {
      assert.equal(decideStop(undefined, roomy, facts({ tokens: 300_000, meeting: true })).kind, 'block');
      assert.equal(decideStop(READY, roomy, facts({ tokens: 300_000, meeting: true })).kind, 'notice');
      const noCeiling = stopContext({ settings: { ...ROOMY, compactCeilingTokens: 0 } });
      assert.deepEqual(decideStop(undefined, noCeiling, cheap({ tokens: 900_000, meeting: true })), { kind: 'none' }, '0 sets no ceiling');
    });
  });
});

function askContext(settings: RefreshSettings = SIZE_ONLY): AskContext {
  return { settings, now: NOW, session: { id: 'alpha', team: 'app', name: 'api' }, handoverPath: HANDOVER, command: 'teamrig' };
}

/** The context at a tool result, its due facts read too. */
function midTurnFacts(tokens: number, due: Partial<DueFacts> = {}): MidTurnFacts {
  return { tokens, meeting: false, due: { handoverHash: null, running: 0, ...due } };
}

/** The context at a tool result, before the due facts are read; `meeting` when the session is in an open meeting. */
function sizeOnly(tokens: number, meeting = false): MidTurnFacts {
  return { tokens, meeting, due: undefined };
}

describe('decideMidTurn', () => {
  it('never asks with the feature off, nor looks again', () => {
    assert.deepEqual(decideMidTurn(undefined, askContext({ ...SIZE_ONLY, enabled: false }), midTurnFacts(400_000)), { kind: 'none', nextAt: null });
  });

  it('says nothing under the threshold and names the size to look again at', () => {
    assert.deepEqual(decideMidTurn(undefined, askContext(), sizeOnly(249_999)), { kind: 'none', nextAt: 250_000 });
    assert.deepEqual(decideMidTurn(ASKED, askContext(), sizeOnly(300_000)), { kind: 'none', nextAt: 312_144 });
  });

  it('reads the due facts only at the threshold, and asks while background work runs, naming it', () => {
    assert.deepEqual(decideMidTurn(undefined, askContext(), sizeOnly(250_000)), { kind: 'measure' });
    const decision = decideMidTurn(undefined, askContext(), midTurnFacts(250_000, { running: 2 }));
    assert.equal(decision.kind, 'ask');
    assert.match(
      decision.kind === 'ask' ? decision.reason : '',
      /\. 2 background tasks you started still run: say in the handover what each result still needs; the fresh start waits until they report back\. Then run `teamrig refresh --ready --session alpha` and end your turn: the fresh start follows it\.$/,
    );
  });

  it('asks within the turn at the threshold, to finish the step, write the handover and end the turn', () => {
    const decision = decideMidTurn(undefined, askContext(), midTurnFacts(251_000, { handoverHash: 'h' }));
    assert.equal(decision.kind, 'ask');
    if (decision.kind !== 'ask') {
      return;
    }
    assert.deepEqual(decision.state, { phase: 'asked', task: null, at: NOW, tokens: 251_000, handoverHash: 'h', midTurn: true });
    assert.equal(decision.nextAt, 301_000);
    assert.match(decision.reason, /^teamrig: your context is 251k \(refresh at 250k\), so refresh within this turn: finish the step you are on and start no other\. /);
    assert.match(decision.reason, /Write your handover to \/team\/handover\/alpha\.md, replacing the whole file \(your fresh start reads all of it\): what the register lacks/);
    assert.match(decision.reason, /Then run `teamrig refresh --ready --session alpha` and end your turn: the fresh start follows it\.$/);
  });

  it("keeps a finished task the Stop hook has not judged yet as the ask's task", () => {
    const decision = decideMidTurn(BOUNDARY, askContext(), midTurnFacts(260_000));
    assert.equal(decision.kind === 'ask' && decision.state.phase === 'asked' ? decision.state.task : undefined, 'T12');
  });

  it('asks a session that went on from an ask again only once its context grew well past it', () => {
    assert.equal(decideMidTurn(ASKED, askContext(), midTurnFacts(312_144)).kind, 'ask');
  });

  it('holds the ask in an open meeting up to the ceiling, naming the size it is due at so the mod looks again', () => {
    assert.deepEqual(decideMidTurn(undefined, askContext(ROOMY), sizeOnly(260_000, true)), { kind: 'none', nextAt: 250_000 });
    assert.deepEqual(decideMidTurn(undefined, askContext(ROOMY), sizeOnly(300_000, true)), { kind: 'measure' });
    assert.deepEqual(decideMidTurn(undefined, askContext(ROOMY), sizeOnly(260_000)), { kind: 'measure' });
  });
});

describe('decideCompact', () => {
  const window = 200_000;

  it("skips Claude Code's own compaction under the ceiling while the handover is asked for or written", () => {
    assert.deepEqual(decideCompact(ASKED, askContext(), { tokens: 170_000, window }), {
      kind: 'skip',
      reason: 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)',
    });
    const written = decideCompact(READY, askContext(), { tokens: 184_999, window });
    assert.equal(written.kind === 'skip' && written.reason.startsWith('teamrig: the handover is written and'), true);
  });

  it('lets it go with no handover pending, so a session with no fresh start coming never runs out of room', () => {
    const refreshed: RefreshState = { phase: 'refreshed', task: null, at: BEFORE };
    const idle: RefreshState = { phase: 'idle', task: 'T12', at: BEFORE, tokens: 100_000, finished: 1 };
    for (const state of [undefined, BOUNDARY, idle, refreshed]) {
      assert.deepEqual(decideCompact(state, askContext(), { tokens: 170_000, window }), { kind: 'go' }, state?.phase);
    }
  });

  it('skips it while an ask a task end left standing is pending (T1666)', () => {
    assert.deepEqual(decideCompact(boundaryOf(MID_TURN, 'T13', NOW), askContext(), { tokens: 170_000, window }), {
      kind: 'skip',
      reason: 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)',
    });
  });

  it('lets it go at the ceiling, a prompt too long for the window too', () => {
    assert.deepEqual(decideCompact(ASKED, askContext(), { tokens: 185_000, window }), { kind: 'go' });
    assert.deepEqual(decideCompact(ASKED, askContext(), { tokens: 230_000, window }), { kind: 'go' });
  });

  it('lets it go with the stop off, the feature off, or a ceiling that leaves no room under the window', () => {
    assert.deepEqual(decideCompact(ASKED, askContext({ ...SIZE_ONLY, compactCeilingTokens: 0 }), { tokens: 170_000, window }), { kind: 'go' });
    assert.deepEqual(decideCompact(ASKED, askContext({ ...SIZE_ONLY, enabled: false }), { tokens: 170_000, window }), { kind: 'go' });
    assert.deepEqual(decideCompact(ASKED, askContext({ ...SIZE_ONLY, compactCeilingTokens: 200_000 }), { tokens: 170_000, window }), { kind: 'go' });
  });

  it('takes a window it is not told as the smallest model window, so only a ceiling under it holds', () => {
    assert.equal(SMALLEST_MODEL_WINDOW, 200_000);
    assert.deepEqual(decideCompact(ASKED, askContext(), { tokens: 170_000, window: undefined }), {
      kind: 'skip',
      reason: 'teamrig: the handover is asked for and the fresh start follows this turn, so compaction waits until 185k (now 170k)',
    });
    const roomy = askContext({ ...SIZE_ONLY, compactCeilingTokens: 400_000 });
    assert.equal(decideCompact(ASKED, roomy, { tokens: 300_000, window: 1_000_000 }).kind, 'skip', 'a told window holds up to its ceiling');
    assert.deepEqual(decideCompact(ASKED, roomy, { tokens: 300_000, window: undefined }), { kind: 'go' }, 'the same window untold lets go');
  });
});

describe('boundaryOf', () => {
  it('counts the task on top of a boundary or a judged one', () => {
    assert.deepEqual(boundaryOf({ ...BOUNDARY, finished: 2 }, 'T13', NOW), { phase: 'boundary', task: 'T13', at: NOW, finished: 3, ask: null });
    assert.deepEqual(boundaryOf({ phase: 'idle', task: 'T12', at: BEFORE, tokens: 90_000, finished: 1 }, 'T13', NOW), {
      phase: 'boundary',
      task: 'T13',
      at: NOW,
      finished: 2,
      ask: null,
    });
  });

  it('counts from 1 with no state, or once a refresh was asked, announced or done', () => {
    const noticed: RefreshState = { ...READY, noticed: true };
    for (const previous of [undefined, noticed, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (RefreshState | undefined)[]) {
      assert.deepEqual(boundaryOf(previous, 'T13', NOW), { phase: 'boundary', task: 'T13', at: NOW, finished: 1, ask: null }, previous?.phase);
    }
  });

  it('leaves the ask a task end came after standing, so refresh --ready still answers it (T1666)', () => {
    const standing = { task: 'T12', at: BEFORE, tokens: 262_144, handoverHash: null };
    assert.deepEqual(boundaryOf(ASKED, 'T13', NOW), { phase: 'boundary', task: 'T13', at: NOW, finished: 1, ask: standing });
    assert.deepEqual(boundaryOf(MID_TURN, 'T13', NOW), {
      phase: 'boundary',
      task: 'T13',
      at: NOW,
      finished: 1,
      ask: { task: null, at: BEFORE, tokens: 131_000, handoverHash: 'old' },
    });
    assert.deepEqual(boundaryOf(boundaryOf(ASKED, 'T13', NOW), 'T14', NOW), { phase: 'boundary', task: 'T14', at: NOW, finished: 2, ask: standing }, 'across task ends');
  });

  it('keeps a handover marked ready but not yet announced, so the turn end announces it (T1666)', () => {
    assert.equal(boundaryOf(READY, 'T13', NOW), READY);
  });
});

describe('decideReady', () => {
  it('refuses unless a handover was asked for, a task end with no ask standing too', () => {
    for (const state of [undefined, BOUNDARY, { phase: 'idle', task: 'T12', at: BEFORE, tokens: 1, finished: 1 }, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (
      | RefreshState
      | undefined
    )[]) {
      const decision = decideReady(state, '# notes', HANDOVER, NOW, CAP);
      assert.equal(decision.kind, 'refused');
      assert.match(decision.kind === 'refused' ? decision.reason : '', /^no refresh was asked of you/);
    }
  });

  it('refuses a missing or blank handover', () => {
    assert.deepEqual(decideReady(ASKED, undefined, HANDOVER, NOW, CAP), { kind: 'refused', reason: `write your handover to ${HANDOVER} first` });
    assert.deepEqual(decideReady(ASKED, ' \n\t', HANDOVER, NOW, CAP), { kind: 'refused', reason: `write your handover to ${HANDOVER} first` });
  });

  it('refuses the handover that was there when it asked', () => {
    const old = '# the last refresh\n';
    const asked: RefreshState = { ...ASKED, handoverHash: handoverHashOf(old) };
    assert.deepEqual(decideReady(asked, old, HANDOVER, NOW, CAP), {
      kind: 'refused',
      reason: `${HANDOVER} is the handover from before; write this refresh's handover there`,
    });
    assert.deepEqual(decideReady(asked, '# this refresh\n', HANDOVER, NOW, CAP), {
      kind: 'ready',
      state: { phase: 'ready', task: 'T12', at: NOW, tokens: 262_144, noticed: false, transcript: null, claudePid: null },
    });
  });

  it('refuses a handover over the byte cap, counted in UTF-8 bytes, unless the cap is 0', () => {
    const atCap = '#'.repeat(100);
    assert.equal(decideReady(ASKED, atCap, HANDOVER, NOW, 100).kind, 'ready');
    assert.deepEqual(decideReady(ASKED, `${'#'.repeat(99)}é`, HANDOVER, NOW, 100), {
      kind: 'refused',
      reason:
        `${HANDOVER} is 101 bytes, over refresh.handoverMaxBytes (100): your fresh start reads all of it. ` +
        'Rewrite it whole, short, with only what your next session needs',
    });
    assert.equal(decideReady(ASKED, '#'.repeat(CAP + 1), HANDOVER, NOW, CAP).kind, 'refused');
    assert.equal(decideReady(ASKED, '#'.repeat(CAP + 1), HANDOVER, NOW, 0).kind, 'ready');
  });

  it('marks a new handover ready, and answers the same when run again', () => {
    assert.deepEqual(decideReady(ASKED, '# notes', HANDOVER, NOW, CAP), {
      kind: 'ready',
      state: { phase: 'ready', task: 'T12', at: NOW, tokens: 262_144, noticed: false, transcript: null, claudePid: null },
    });
    assert.deepEqual(decideReady(READY, '# notes', HANDOVER, NOW, CAP), { kind: 'already' });
  });

  it('answers an ask a task end left standing, after that task, against the handover from before the ask (T1666)', () => {
    const old = '# the last refresh\n';
    const standing = boundaryOf({ ...MID_TURN, handoverHash: handoverHashOf(old) }, 'T13', NOW);
    assert.deepEqual(decideReady(standing, old, HANDOVER, NOW, CAP), {
      kind: 'refused',
      reason: `${HANDOVER} is the handover from before; write this refresh's handover there`,
    });
    assert.deepEqual(decideReady(standing, '# this refresh\n', HANDOVER, NOW, CAP), {
      kind: 'ready',
      state: { phase: 'ready', task: 'T13', at: NOW, tokens: 131_000, noticed: false, transcript: null, claudePid: null },
    });
  });

  it('keeps a refresh asked mid-task without a task, and the size it was asked at', () => {
    const decision = decideReady({ ...ASKED, task: null, tokens: null }, '# notes', HANDOVER, NOW, CAP);
    assert.deepEqual(decision.kind === 'ready' ? decision.state : undefined, { phase: 'ready', task: null, at: NOW, tokens: null, noticed: false, transcript: null, claudePid: null });
  });
});

describe('decideStart', () => {
  it('points a cleared or new session at its handover, once', () => {
    for (const source of ['clear', 'startup']) {
      assert.deepEqual(decideStart(READY, source, DEFAULT_REFRESH, HANDOVER, NOW), {
        kind: 'inject',
        note:
          `You were refreshed after T12; read your handover first: ${HANDOVER}. Then carry on with its next steps. ` +
          'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.',
        state: { phase: 'refreshed', task: 'T12', at: NOW },
      });
    }
    assert.deepEqual(decideStart({ phase: 'refreshed', task: 'T12', at: NOW }, 'clear', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' });
    const midTask = decideStart({ ...READY, task: null, tokens: 262_144 }, 'clear', DEFAULT_REFRESH, HANDOVER, NOW);
    assert.deepEqual(midTask, {
      kind: 'inject',
      note:
        `You were refreshed mid-task; read your handover first: ${HANDOVER}. Then carry on with its next steps. ` +
        'Read a file with the Read tool before you Edit or Write it: a read by cat or sed, or one before the refresh, does not count.',
      state: { phase: 'refreshed', task: null, at: NOW },
    });
  });

  it('forgets the size a refresh was asked at once the context is small again, so the next ask comes at the threshold', () => {
    const asked: RefreshState = ASKED;
    const ready: RefreshState = { ...READY, tokens: 262_144, noticed: true };
    for (const source of ['clear', 'startup', 'compact']) {
      assert.deepEqual(decideStart(asked, source, DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'reset', state: { ...asked, tokens: null } }, source);
    }
    assert.deepEqual(decideStart(ready, 'compact', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'reset', state: { ...ready, tokens: null } });
    assert.equal(decideStart(ready, 'clear', DEFAULT_REFRESH, HANDOVER, NOW).kind, 'inject', 'a fresh start takes the handover');
    for (const source of ['resume', 'fork', undefined]) {
      assert.deepEqual(decideStart(asked, source, DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' }, source);
    }
    assert.deepEqual(decideStart({ ...ASKED, tokens: null }, 'compact', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' }, 'already forgotten');
  });

  it('leaves the handover waiting on a start that keeps the old context', () => {
    for (const source of ['compact', 'resume', 'fork', undefined]) {
      assert.deepEqual(decideStart(READY, source, DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' }, source);
    }
  });

  it('starts the task count over when the context is small again, a compaction too', () => {
    const idle: RefreshState = { phase: 'idle', task: 'T12', at: BEFORE, tokens: 150_000, finished: 2 };
    for (const source of ['clear', 'startup', 'compact']) {
      assert.deepEqual(decideStart(idle, source, DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'reset', state: { ...idle, finished: 0 } }, source);
    }
    const boundary: RefreshState = { ...BOUNDARY, finished: 3 };
    assert.deepEqual(decideStart(boundary, 'compact', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'reset', state: { ...boundary, finished: 0 } });
    for (const source of ['resume', 'fork', undefined]) {
      assert.deepEqual(decideStart(idle, source, DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' }, source);
    }
    assert.deepEqual(decideStart({ ...idle, finished: 0 }, 'compact', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' }, 'already 0: nothing to write');
    assert.deepEqual(decideStart(idle, 'compact', { enabled: false }, HANDOVER, NOW), { kind: 'none' });
  });

  it('does nothing before the handover is ready, or with the feature off', () => {
    assert.deepEqual(decideStart({ ...ASKED, tokens: null }, 'clear', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' });
    assert.deepEqual(decideStart(undefined, 'clear', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' });
    assert.deepEqual(decideStart(READY, 'clear', { enabled: false }, HANDOVER, NOW), { kind: 'none' });
  });
});

describe('thousands', () => {
  it('rounds to the nearest thousand', () => {
    assert.deepEqual([thousands(262_144), thousands(499), thousands(1_500), thousands(0)], ['262k', '0k', '2k', '0k']);
  });
});

describe('wakePromptOf', () => {
  const TAKEN: RefreshState = { phase: 'refreshed', task: 'T12', at: NOW };
  const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

  it('wakes the session whose refresh this /clear just took, pointing it at its handover', () => {
    assert.equal(
      wakePromptOf(TAKEN, HANDOVER, later(WAKE_WINDOW_MS)),
      `You were started fresh after your context refresh at T12: read your handover ${HANDOVER} now, take over what the SessionStart note lists, then carry on with its next steps.`,
    );
  });

  it('names no task for a refresh asked mid-task', () => {
    assert.match(wakePromptOf({ ...TAKEN, task: null }, HANDOVER, NOW) ?? '', /^You were started fresh after your context refresh: read your handover /);
  });

  it('wakes nothing for a refresh taken earlier, not taken yet, or none', () => {
    assert.equal(wakePromptOf(TAKEN, HANDOVER, later(WAKE_WINDOW_MS + 1)), undefined);
    assert.equal(wakePromptOf(TAKEN, HANDOVER, later(-1)), undefined);
    assert.equal(wakePromptOf(READY, HANDOVER, NOW), undefined);
    assert.equal(wakePromptOf(undefined, HANDOVER, NOW), undefined);
  });
});
