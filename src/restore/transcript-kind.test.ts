import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptKindOf } from './transcript-kind.ts';

const OLD = '2ecc536b-b6c9-4b2b-ac87-98e97c03b5e7';
const JOB = '9ac07f9d-2832-4320-88f9-69e667e4c38e';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);
const tabTurn = line({ type: 'assistant', entrypoint: 'cli', sessionId: OLD, message: { model: 'claude-opus-5-5' } });
const jobTurn = line({ type: 'user', entrypoint: 'cli', sessionKind: 'bg', sessionId: JOB, message: { role: 'user', content: 'go' } });
const continued = line({ type: 'continued-in', timestamp: '2030-01-08T08:00:00Z', sessionId: OLD, continuedInSessionId: JOB });
const metadata = [line({ type: 'custom-title', customTitle: 'po' }), line({ type: 'mode', mode: 'normal' }), line({ type: 'last-prompt', lastPrompt: 'x' })];

describe('transcriptKindOf', () => {
  it("reads a tab's transcript as a tab that was not continued anywhere", () => {
    assert.deepEqual(transcriptKindOf([tabTurn, ...metadata, ''].join('\n')), { background: false, continuedIn: undefined });
  });

  it('reads a background job by its last turn, past the metadata after it', () => {
    assert.deepEqual(transcriptKindOf([tabTurn, jobTurn, ...metadata].join('\n')), { background: true, continuedIn: undefined });
  });

  it('reads a tab sent to the background by its last turn, and one brought back to a tab', () => {
    assert.equal(transcriptKindOf([tabTurn, jobTurn].join('\n')).background, true);
    assert.equal(transcriptKindOf([jobTurn, tabTurn].join('\n')).background, false);
  });

  it('names the session a transcript was continued in after its last turn, the latest when there are two', () => {
    const later = line({ type: 'continued-in', sessionId: OLD, continuedInSessionId: 'later-session' });
    assert.deepEqual(transcriptKindOf([tabTurn, continued, ...metadata].join('\n')), { background: false, continuedIn: JOB });
    assert.equal(transcriptKindOf([tabTurn, continued, later].join('\n')).continuedIn, 'later-session');
  });

  it('drops a continuation the session had a turn after: it was resumed and runs here again', () => {
    assert.deepEqual(transcriptKindOf([tabTurn, continued, tabTurn].join('\n')), { background: false, continuedIn: undefined });
  });

  it('skips a torn first line and a message that only mentions a continuation, and reads an empty tail as a tab', () => {
    const torn = jobTurn.slice(20);
    const mention = line({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'the continued-in record' } });
    assert.deepEqual(transcriptKindOf([torn, tabTurn].join('\n')), { background: false, continuedIn: undefined });
    assert.deepEqual(transcriptKindOf([torn, continued].join('\n')), { background: false, continuedIn: JOB });
    assert.deepEqual(transcriptKindOf(mention), { background: false, continuedIn: undefined });
    assert.deepEqual(transcriptKindOf(''), { background: false, continuedIn: undefined });
  });
});
