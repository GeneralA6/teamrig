import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MS_PER_DAY, MS_PER_MINUTE } from '../core/time.ts';
import { apiErrorLine, promptLine, textLine, transcript } from '../testing/transcript-lines.ts';
import {
  applyLoginEvent,
  authFailureOf,
  formatLoginMarker,
  loginExpired,
  loginLogLine,
  loginMarkerPath,
  parseLoginMarker,
  STRANDED_KEEP_MS,
  type LoginChange,
  type LoginEvent,
  type LoginMarker,
} from './login.ts';

const TAB_A = '0123abcd-0000-4000-8000-00000000000a';
const TAB_B = '0123abcd-0000-4000-8000-00000000000b';
const TAB_C = '0123abcd-0000-4000-8000-00000000000c';
const EXPIRY = Date.parse('2030-01-08T00:02:00Z');

function failed(claudeSession: string, at: number): LoginEvent {
  return { kind: 'auth-failed', claudeSession, at };
}

function answered(claudeSession: string, at: number): LoginEvent {
  return { kind: 'answered', claudeSession, at };
}

/** The marker after `events`, from none; each must change it. */
function markerAfter(...events: readonly LoginEvent[]): LoginMarker {
  let marker: LoginMarker | undefined;
  for (const event of events) {
    marker = written(applyLoginEvent(marker, event)).marker;
  }
  assert.ok(marker !== undefined);
  return marker;
}

function written(change: LoginChange): Extract<LoginChange, { kind: 'write' }> {
  assert.equal(change.kind, 'write');
  return change;
}

/** A tail reader that fails the spec when the decision should not have read the transcript. */
async function noTail(): Promise<string | undefined> {
  return assert.fail('the payload decides; the transcript is not read');
}

describe('login marker', () => {
  it('sits beside the restore sessions folder of its kit home', () => {
    assert.equal(loginMarkerPath(join('/', 'kit')), join('/', 'kit', 'restore', 'login.json'));
  });

  it("takes the payload's error over the transcript", async () => {
    assert.equal(await authFailureOf({ error: 'authentication_failed' }, noTail), true);
    assert.equal(await authFailureOf({ error: 'overloaded' }, noTail), false);
  });

  it("falls back to the transcript's last assistant record when the payload names no error", async () => {
    const failedTurn = transcript([promptLine('2030-01-08T06:00:00Z'), apiErrorLine('2030-01-08T06:00:14Z', TAB_A)]);
    assert.equal(await authFailureOf({}, async () => failedTurn), true);
    // A torn first line, as a tail cut mid-record leaves it, is skipped.
    assert.equal(await authFailureOf({}, async () => `ssistant","error":"x"}\n${failedTurn}`), true);
    const otherError = transcript([apiErrorLine('2030-01-08T06:00:14Z', TAB_A, 'server_error', 'API Error: 500')]);
    assert.equal(await authFailureOf({}, async () => otherError), false);
    // An old failure the model answered after is not this turn's.
    const answeredSince = transcript([apiErrorLine('2030-01-08T06:00:14Z', TAB_A), promptLine('2030-01-08T08:20:00Z'), textLine('u2', ['done'])]);
    assert.equal(await authFailureOf({}, async () => answeredSince), false);
    assert.equal(await authFailureOf({}, async () => undefined), false);
  });

  it('starts an expiry at the first auth failure and strands its tab', () => {
    const change = written(applyLoginEvent(undefined, failed(TAB_A, EXPIRY)));
    assert.equal(change.note, 'expired');
    assert.deepEqual(change.marker, { expiredAt: EXPIRY, lastFailAt: EXPIRY, recoveredAt: undefined, stranded: new Map([[TAB_A, EXPIRY]]) });
    assert.equal(loginExpired(change.marker), true);
  });

  it('keeps one expiry for every failure until a good turn, its first and last failure times', () => {
    const marker = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY + MS_PER_MINUTE));
    const late = written(applyLoginEvent(marker, failed(TAB_C, EXPIRY - 1_000)));
    assert.equal(late.note, 'stranded', 'a failure the hooks report late joins the expiry');
    assert.deepEqual([late.marker.expiredAt, late.marker.lastFailAt, late.marker.stranded.size], [EXPIRY - 1_000, EXPIRY + MS_PER_MINUTE, 3]);
  });

  it('recovers at the first good turn end after the last failure, and frees only that tab', () => {
    const marker = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY + 1_000));
    const recovered = written(applyLoginEvent(marker, answered(TAB_A, EXPIRY + 6 * 60 * MS_PER_MINUTE)));
    assert.equal(recovered.note, 'recovered');
    assert.equal(recovered.marker.recoveredAt, EXPIRY + 6 * 60 * MS_PER_MINUTE);
    assert.deepEqual([...recovered.marker.stranded.keys()], [TAB_B], 'the other tab stays stuck until it is retried');
    assert.equal(loginExpired(recovered.marker), false);
  });

  it('takes no turn that ended before the last failure as a recovery, though it frees its own earlier failure', () => {
    const marker = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY + 2_000));
    const freed = written(applyLoginEvent(marker, answered(TAB_A, EXPIRY + 1_000)));
    assert.equal(freed.note, undefined);
    assert.deepEqual([freed.marker.recoveredAt, [...freed.marker.stranded.keys()]], [undefined, [TAB_B]]);
    assert.deepEqual(applyLoginEvent(marker, answered(TAB_C, EXPIRY + 1_000)), { kind: 'none' });
  });

  it('changes nothing at a good turn end with no marker, or with the login working and the tab not stuck', () => {
    assert.deepEqual(applyLoginEvent(undefined, answered(TAB_A, EXPIRY)), { kind: 'none' });
    const recovered = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY), answered(TAB_A, EXPIRY + MS_PER_MINUTE));
    assert.deepEqual(applyLoginEvent(recovered, answered(TAB_C, EXPIRY + 2 * MS_PER_MINUTE)), { kind: 'none' });
    assert.deepEqual(applyLoginEvent(recovered, answered(TAB_A, EXPIRY + 2 * MS_PER_MINUTE)), { kind: 'none' });
  });

  it('starts a new expiry at a failure after the recovery; one from before it only strands its tab', () => {
    const recoveredAt = EXPIRY + MS_PER_MINUTE;
    const recovered = markerAfter(failed(TAB_A, EXPIRY), answered(TAB_B, recoveredAt));
    const late = written(applyLoginEvent(recovered, failed(TAB_C, recoveredAt - 1)));
    assert.equal(late.note, 'stranded');
    assert.deepEqual([late.marker.expiredAt, late.marker.lastFailAt, late.marker.recoveredAt, late.marker.stranded.has(TAB_C)], [EXPIRY, recoveredAt - 1, recoveredAt, true]);
    const again = written(applyLoginEvent(late.marker, failed(TAB_B, recoveredAt + MS_PER_DAY)));
    assert.equal(again.note, 'expired');
    assert.deepEqual([again.marker.expiredAt, again.marker.lastFailAt, again.marker.recoveredAt], [recoveredAt + MS_PER_DAY, recoveredAt + MS_PER_DAY, undefined]);
    assert.deepEqual([...again.marker.stranded.keys()].sort(), [TAB_A, TAB_B, TAB_C], 'a tab stuck in the old expiry stays stuck');
  });

  it('forgets a tab stuck longer than the keep time at the next change', () => {
    const marker = markerAfter(failed(TAB_A, EXPIRY), answered(TAB_B, EXPIRY + 1_000));
    const pruned = written(applyLoginEvent(marker, answered(TAB_C, EXPIRY + STRANDED_KEEP_MS + 1)));
    assert.deepEqual([pruned.note, pruned.marker.stranded.size], [undefined, 0]);
    assert.deepEqual(applyLoginEvent(marker, answered(TAB_C, EXPIRY + STRANDED_KEEP_MS)), { kind: 'none' });
  });

  it('reads back what it writes, and no damaged or foreign marker', () => {
    const expired = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY + 1_000));
    const recovered = markerAfter(failed(TAB_A, EXPIRY), answered(TAB_A, EXPIRY + 1_000));
    for (const marker of [expired, recovered]) {
      assert.deepEqual(parseLoginMarker(formatLoginMarker(marker)), marker);
    }
    assert.match(formatLoginMarker(expired), /"expiredAt": "2030-01-08T00:02:00.000Z"/);
    const good = { expiredAt: '2030-01-08T00:02:00Z', lastFailAt: '2030-01-08T00:02:00Z', stranded: {} };
    for (const damaged of ['not json', '[]', JSON.stringify({ ...good, expiredAt: 'soon' }), JSON.stringify({ ...good, recoveredAt: 7 }), JSON.stringify({ ...good, stranded: { '../x': '2030-01-08T00:02:00Z' } }), JSON.stringify({ ...good, stranded: { [TAB_A]: 'later' } }), JSON.stringify({ ...good, stranded: [] })]) {
      assert.equal(parseLoginMarker(damaged), undefined, damaged);
    }
    assert.deepEqual(parseLoginMarker(JSON.stringify(good))?.stranded, new Map());
  });

  it('logs a new expiry, each more tab stuck, and the recovery, with how many tabs are stuck', () => {
    const marker = markerAfter(failed(TAB_A, EXPIRY), failed(TAB_B, EXPIRY));
    assert.equal(loginLogLine('expired', 'app/alpha', marker), 'login: expired, app/alpha ended its turn on Login expired; 2 tab(s) stuck');
    assert.equal(loginLogLine('stranded', TAB_B, marker), `login: ${TAB_B} ended its turn on Login expired; 2 tab(s) stuck`);
    assert.equal(loginLogLine('recovered', 'app/alpha', marker), 'login: works again, app/alpha answered; 2 tab(s) stuck');
  });
});
