import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFRESH } from '../config/defaults.ts';
import {
  boundaryOf,
  decideReady,
  decideStart,
  decideStop,
  handoverHashOf,
  thousands,
  type BoundaryFacts,
  type RefreshSettings,
  type StopContext,
  wakePromptOf,
  WAKE_WINDOW_MS,
} from './decide.ts';
import type { RefreshState } from './state.ts';

const BEFORE = '2030-01-08T09:00:00.000Z';
const NOW = '2030-01-08T10:00:00.000Z';
const HANDOVER = '/team/handover/alpha.md';

const BOUNDARY: RefreshState = { phase: 'boundary', task: 'T12', at: BEFORE, finished: 1 };
const ASKED: RefreshState = { phase: 'asked', task: 'T12', at: BEFORE, tokens: 262_144, handoverHash: null };
const READY: RefreshState = { phase: 'ready', task: 'T12', at: BEFORE, noticed: false, transcript: null, claudePid: null };
/** The size rule alone at 250k, so each size test reads apart from the task count. */
const SIZE_ONLY: RefreshSettings = { ...DEFAULT_REFRESH, contextTokens: 250_000, everyTasks: 0 };
const COUNTED: RefreshSettings = { ...SIZE_ONLY, everyTasks: 3, everyTasksMinTokens: 80_000 };

function stopContext(overrides: Partial<StopContext> = {}): StopContext {
  return {
    stopHookActive: false,
    settings: SIZE_ONLY,
    now: NOW,
    session: { id: 'alpha', name: 'api' },
    handoverPath: HANDOVER,
    command: 'teamrig',
    canRestart: false,
    transcript: null,
    ...overrides,
  };
}

function facts(overrides: Partial<BoundaryFacts> = {}): BoundaryFacts {
  return { requestedBy: undefined, tokens: 120_000, handoverHash: null, running: 0, ...overrides };
}

describe('decideStop', () => {
  it('does nothing without state, with the feature off, or after a boundary was judged', () => {
    assert.deepEqual(decideStop(undefined, stopContext()), { kind: 'none' });
    assert.deepEqual(decideStop(BOUNDARY, stopContext({ settings: { ...DEFAULT_REFRESH, enabled: false } })), { kind: 'none' });
    assert.deepEqual(decideStop(READY, stopContext({ settings: { ...DEFAULT_REFRESH, enabled: false } })), { kind: 'none' });
    for (const state of [
      { phase: 'idle', task: 'T12', at: BEFORE, tokens: 5, finished: 1 },
      ASKED,
      { phase: 'refreshed', task: 'T12', at: BEFORE },
      { ...READY, noticed: true },
    ] satisfies RefreshState[]) {
      assert.deepEqual(decideStop(state, stopContext(), facts({ tokens: 900_000 })), { kind: 'none' }, state.phase);
    }
  });

  it('asks for the facts of a boundary before judging it, and of a written handover before the notice', () => {
    assert.deepEqual(decideStop(BOUNDARY, stopContext()), { kind: 'measure' });
    assert.deepEqual(decideStop(READY, stopContext()), { kind: 'measure' });
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
  });

  it('asks for the handover at or over the threshold, naming the size, the path and the ready command', () => {
    const decision = decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, handoverHash: 'abc' }));
    assert.deepEqual(decision, {
      kind: 'block',
      state: { phase: 'asked', task: 'T12', at: NOW, tokens: 262_144, handoverHash: 'abc' },
      reason:
        'teamrig: your context is 262k (refresh at 250k) and you just finished T12. Write your handover to /team/handover/alpha.md ' +
        '(what is in progress and the next step of each; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), then run ' +
        '`teamrig refresh --ready --session alpha`. Do not start new work.',
    });
    assert.equal(decideStop(BOUNDARY, stopContext(), facts({ tokens: 250_000 })).kind, 'block');
  });

  it('asks for the handover when the lead asked, whatever the size', () => {
    const small = decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', tokens: 40_400 }));
    assert.equal(small.kind, 'block');
    assert.match(small.kind === 'block' ? small.reason : '', /^teamrig: boss asked for a refresh \(your context is 40k\) and you just finished T12\. /);
    const unknown = decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', tokens: undefined }));
    assert.match(unknown.kind === 'block' ? unknown.reason : '', /^teamrig: boss asked for a refresh and you just finished T12\. /);
    assert.deepEqual(unknown.kind === 'block' ? unknown.state : undefined, { phase: 'asked', task: 'T12', at: NOW, tokens: null, handoverHash: null });
  });

  it('waits while background work runs: a due refresh leaves the boundary for a later stop', () => {
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, running: 1 })), { kind: 'none' });
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ requestedBy: 'boss', running: 2 })), { kind: 'none' });
    assert.equal(decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, running: 0 })).kind, 'block', 'asks once the work ended');
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
    assert.deepEqual(decideStop(third, stopContext({ settings: COUNTED }), facts({ tokens: 95_000, running: 1 })), { kind: 'none' }, 'waits for running work');
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
      title: 'api: type /clear',
      restart: false,
    });
    const plain = decideStop(READY, stopContext({ settings: { ...DEFAULT_REFRESH, tabTitle: false } }), facts());
    assert.equal(plain.kind === 'notice' ? plain.title : 'other', undefined);
    assert.deepEqual(decideStop(READY, stopContext({ canRestart: true }), facts()), {
      kind: 'notice',
      state: { ...READY, noticed: true },
      message: 'teamrig: api finished T12 and wrote its handover; teamrig starts it fresh once it has been idle 15 s (type anything to keep this context)',
      title: 'api: restarting',
      restart: true,
    });
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
});

describe('boundaryOf', () => {
  it('counts the task on top of a boundary or a judged one', () => {
    assert.deepEqual(boundaryOf({ ...BOUNDARY, finished: 2 }, 'T13', NOW), { phase: 'boundary', task: 'T13', at: NOW, finished: 3 });
    assert.deepEqual(boundaryOf({ phase: 'idle', task: 'T12', at: BEFORE, tokens: 90_000, finished: 1 }, 'T13', NOW), {
      phase: 'boundary',
      task: 'T13',
      at: NOW,
      finished: 2,
    });
  });

  it('counts from 1 with no state, or once a refresh was asked, written or done', () => {
    for (const previous of [undefined, ASKED, READY, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (RefreshState | undefined)[]) {
      assert.deepEqual(boundaryOf(previous, 'T13', NOW), { phase: 'boundary', task: 'T13', at: NOW, finished: 1 }, previous?.phase);
    }
  });
});

describe('decideReady', () => {
  it('refuses unless the Stop hook asked for a handover', () => {
    for (const state of [undefined, BOUNDARY, { phase: 'idle', task: 'T12', at: BEFORE, tokens: 1, finished: 1 }, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (
      | RefreshState
      | undefined
    )[]) {
      const decision = decideReady(state, '# notes', HANDOVER, NOW);
      assert.equal(decision.kind, 'refused');
      assert.match(decision.kind === 'refused' ? decision.reason : '', /^no refresh was asked of you/);
    }
  });

  it('refuses a missing or blank handover', () => {
    assert.deepEqual(decideReady(ASKED, undefined, HANDOVER, NOW), { kind: 'refused', reason: `write your handover to ${HANDOVER} first` });
    assert.deepEqual(decideReady(ASKED, ' \n\t', HANDOVER, NOW), { kind: 'refused', reason: `write your handover to ${HANDOVER} first` });
  });

  it('refuses the handover that was there when it asked', () => {
    const old = '# the last refresh\n';
    const asked: RefreshState = { ...ASKED, handoverHash: handoverHashOf(old) };
    assert.deepEqual(decideReady(asked, old, HANDOVER, NOW), {
      kind: 'refused',
      reason: `${HANDOVER} is the handover from before; write this refresh's handover there`,
    });
    assert.deepEqual(decideReady(asked, '# this refresh\n', HANDOVER, NOW), { kind: 'ready', state: { phase: 'ready', task: 'T12', at: NOW, noticed: false, transcript: null, claudePid: null } });
  });

  it('marks a new handover ready, and answers the same when run again', () => {
    assert.deepEqual(decideReady(ASKED, '# notes', HANDOVER, NOW), { kind: 'ready', state: { phase: 'ready', task: 'T12', at: NOW, noticed: false, transcript: null, claudePid: null } });
    assert.deepEqual(decideReady(READY, '# notes', HANDOVER, NOW), { kind: 'already' });
  });
});

describe('decideStart', () => {
  it('points a cleared or new session at its handover, once', () => {
    for (const source of ['clear', 'startup']) {
      assert.deepEqual(decideStart(READY, source, DEFAULT_REFRESH, HANDOVER, NOW), {
        kind: 'inject',
        note: `You were refreshed after T12; read your handover first: ${HANDOVER}. Then carry on with its next steps.`,
        state: { phase: 'refreshed', task: 'T12', at: NOW },
      });
    }
    assert.deepEqual(decideStart({ phase: 'refreshed', task: 'T12', at: NOW }, 'clear', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' });
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
    assert.deepEqual(decideStart(ASKED, 'clear', DEFAULT_REFRESH, HANDOVER, NOW), { kind: 'none' });
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

  it('wakes nothing for a refresh taken earlier, not taken yet, or none', () => {
    assert.equal(wakePromptOf(TAKEN, HANDOVER, later(WAKE_WINDOW_MS + 1)), undefined);
    assert.equal(wakePromptOf(TAKEN, HANDOVER, later(-1)), undefined);
    assert.equal(wakePromptOf(READY, HANDOVER, NOW), undefined);
    assert.equal(wakePromptOf(undefined, HANDOVER, NOW), undefined);
  });
});
