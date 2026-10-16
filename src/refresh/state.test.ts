import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRefreshRequest, formatRefreshState, parseRefreshRequest, parseRefreshState, type RefreshState } from './state.ts';

const AT = '2030-01-08T10:00:00.000Z';

const EVERY_PHASE: readonly RefreshState[] = [
  { phase: 'boundary', task: 'T12', at: AT, finished: 1 },
  { phase: 'idle', task: 'T12', at: AT, tokens: 120_000, finished: 2 },
  { phase: 'idle', task: 'T12', at: AT, tokens: null, finished: 0 },
  { phase: 'asked', task: 'T12', at: AT, tokens: 262_000, handoverHash: '0123456789abcdef' },
  { phase: 'asked', task: 'T12', at: AT, tokens: null, handoverHash: null },
  { phase: 'ready', task: 'T12', at: AT, noticed: false, transcript: null },
  { phase: 'ready', task: 'T12', at: AT, noticed: true, transcript: '/claude/projects/p/s.jsonl' },
  { phase: 'refreshed', task: 'T12', at: AT },
];

describe('refresh state files', () => {
  it('reads back every phase it writes, as one versioned line', () => {
    for (const state of EVERY_PHASE) {
      const text = formatRefreshState(state);
      assert.match(text, /^\{"v":1,"phase":"[a-z]+",.*\}\n$/);
      assert.deepEqual(parseRefreshState(text), state);
    }
  });

  it('reads a damaged file, another format or an unknown phase as no state', () => {
    for (const text of [
      '',
      '{"v":1,"phase":"boundary","task":"T1"',
      '{"phase":"boundary","task":"T1","at":"x"}',
      '{"v":2,"phase":"boundary","task":"T1","at":"x"}',
      '{"v":1,"phase":"later","task":"T1","at":"x"}',
      '{"v":1,"phase":"boundary","at":"x"}',
      '{"v":1,"phase":"boundary","task":"T1"}',
      '{"v":1,"phase":"idle","task":"T1","at":"x","tokens":-1}',
      '{"v":1,"phase":"idle","task":"T1","at":"x"}',
      '{"v":1,"phase":"boundary","task":"T1","at":"x","finished":-1}',
      '{"v":1,"phase":"boundary","task":"T1","at":"x","finished":1.5}',
      '{"v":1,"phase":"idle","task":"T1","at":"x","tokens":5,"finished":"2"}',
      '{"v":1,"phase":"asked","task":"T1","at":"x","tokens":1,"handoverHash":7}',
      '{"v":1,"phase":"asked","task":"T1","at":"x","tokens":"1","handoverHash":null}',
      '{"v":1,"phase":"ready","task":"T1","at":"x","noticed":"no"}',
      '[1]',
    ]) {
      assert.equal(parseRefreshState(text), undefined, text);
    }
  });

  it('reads a boundary or a judged one from before the task count as its first task, or none counted', () => {
    assert.deepEqual(parseRefreshState('{"v":1,"phase":"boundary","task":"T1","at":"x"}'), { phase: 'boundary', task: 'T1', at: 'x', finished: 1 });
    assert.deepEqual(parseRefreshState('{"v":1,"phase":"idle","task":"T1","at":"x","tokens":5}'), { phase: 'idle', task: 'T1', at: 'x', tokens: 5, finished: 0 });
  });

  it('reads back a request, and a damaged one as none', () => {
    const request = { by: 'lead', at: AT };
    assert.deepEqual(parseRefreshRequest(formatRefreshRequest(request)), request);
    assert.equal(parseRefreshRequest('{"v":1,"by":"lead"}'), undefined);
    assert.equal(parseRefreshRequest('{"v":1,"at":"x"}'), undefined);
    assert.equal(parseRefreshRequest('{"v":2,"by":"lead","at":"x"}'), undefined);
    assert.equal(parseRefreshRequest('nope'), undefined);
  });
});
