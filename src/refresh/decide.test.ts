import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REFRESH } from '../config/defaults.ts';
import { decideReady, decideStart, decideStop, handoverHashOf, thousands, type BoundaryFacts, type StopContext } from './decide.ts';
import type { RefreshState } from './state.ts';

const BEFORE = '2030-01-08T09:00:00.000Z';
const NOW = '2030-01-08T10:00:00.000Z';
const HANDOVER = '/team/handover/alpha.md';

const BOUNDARY: RefreshState = { phase: 'boundary', task: 'T12', at: BEFORE };
const ASKED: RefreshState = { phase: 'asked', task: 'T12', at: BEFORE, tokens: 262_144, handoverHash: null };
const READY: RefreshState = { phase: 'ready', task: 'T12', at: BEFORE, noticed: false };

function stopContext(overrides: Partial<StopContext> = {}): StopContext {
  return {
    stopHookActive: false,
    settings: DEFAULT_REFRESH,
    now: NOW,
    session: { id: 'alpha', name: 'api' },
    handoverPath: HANDOVER,
    command: 'teamrig',
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
      { phase: 'idle', task: 'T12', at: BEFORE, tokens: 5 },
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
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: 249_999 },
    });
    assert.deepEqual(decideStop(BOUNDARY, stopContext(), facts({ tokens: undefined })), {
      kind: 'write',
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: null },
    });
  });

  it('asks for the handover at or over the threshold, naming the size, the path and the ready command', () => {
    const decision = decideStop(BOUNDARY, stopContext(), facts({ tokens: 262_144, handoverHash: 'abc' }));
    assert.deepEqual(decision, {
      kind: 'block',
      state: { phase: 'asked', task: 'T12', at: NOW, tokens: 262_144, handoverHash: 'abc' },
      reason:
        'teamrig: your context is 262k (refresh at 250k) and you just finished T12. Write your handover to /team/handover/alpha.md ' +
        '(what is in progress, the next step of each, open questions, where things are), then run ' +
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
      state: { phase: 'idle', task: 'T12', at: NOW, tokens: 120_000 },
    });
  });

  it('follows the threshold the team set', () => {
    const settings = { ...DEFAULT_REFRESH, contextTokens: 150_000 };
    const decision = decideStop(BOUNDARY, stopContext({ settings }), facts({ tokens: 150_000 }));
    assert.match(decision.kind === 'block' ? decision.reason : '', /your context is 150k \(refresh at 150k\)/);
  });

  it('tells the user once that the handover is written, with the tab mark when the team wants it', () => {
    assert.deepEqual(decideStop(READY, stopContext(), facts()), {
      kind: 'notice',
      state: { ...READY, noticed: true },
      message: 'teamrig: api finished T12 and wrote its handover; type /clear for a fresh start',
      title: 'api: type /clear',
    });
    const plain = decideStop(READY, stopContext({ settings: { ...DEFAULT_REFRESH, tabTitle: false } }), facts());
    assert.equal(plain.kind === 'notice' ? plain.title : 'other', undefined);
  });

  it('gives the notice in the turn a Stop hook continued, since that turn runs refresh --ready', () => {
    assert.equal(decideStop(READY, stopContext({ stopHookActive: true }), facts()).kind, 'notice');
  });

  it('holds the notice while background work runs, so the user is not told to /clear over it', () => {
    assert.deepEqual(decideStop(READY, stopContext(), facts({ running: 1 })), { kind: 'none' });
    assert.equal(decideStop(READY, stopContext(), facts({ running: 0 })).kind, 'notice');
  });
});

describe('decideReady', () => {
  it('refuses unless the Stop hook asked for a handover', () => {
    for (const state of [undefined, BOUNDARY, { phase: 'idle', task: 'T12', at: BEFORE, tokens: 1 }, { phase: 'refreshed', task: 'T12', at: BEFORE }] satisfies (
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
    assert.deepEqual(decideReady(asked, '# this refresh\n', HANDOVER, NOW), { kind: 'ready', state: { phase: 'ready', task: 'T12', at: NOW, noticed: false } });
  });

  it('marks a new handover ready, and answers the same when run again', () => {
    assert.deepEqual(decideReady(ASKED, '# notes', HANDOVER, NOW), { kind: 'ready', state: { phase: 'ready', task: 'T12', at: NOW, noticed: false } });
    assert.deepEqual(decideReady(READY, '# notes', HANDOVER, NOW), { kind: 'already' });
  });
});

describe('decideStart', () => {
  it('points a cleared or new session at its handover, once', () => {
    for (const source of ['clear', 'startup']) {
      assert.deepEqual(decideStart(READY, source, DEFAULT_REFRESH, HANDOVER, NOW), {
        kind: 'inject',
        note: `You were refreshed after T12; read your handover first: ${HANDOVER}`,
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
