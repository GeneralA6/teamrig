import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MS_PER_MINUTE } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { API_RETRY_LIMIT, apiGaveUpLine, apiRetriesSpentOn, apiRetryLine, claimApiRetry, decideApiRetry, TRANSIENT_API_ERRORS } from './api-error.ts';
import type { ApiErrorState, RestoreEntry } from './entry.ts';
import { RestoreRegistry } from './registry.ts';

const ID = '0123abcd-0000-4000-8000-00000000000a';
const FAIL_AT = Date.parse('2030-01-08T09:00:00Z');
const DIR = '/kit/restore/sessions';

/** A tab whose last turn ended at FAIL_AT on `apiError` (server_error, no retry yet, by default). */
function failed(apiError: Partial<ApiErrorState> = {}, overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession: ID,
    projectDir: '/work/app',
    transcriptPath: '/u/.claude/projects/app/x.jsonl',
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 6000,
    team: 'app',
    session: 'alpha',
    state: 'error',
    createdAt: FAIL_AT - 60 * MS_PER_MINUTE,
    updatedAt: FAIL_AT,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    apiError: { code: 'server_error', failedAt: FAIL_AT, retries: 0, retriedAt: undefined, ...apiError },
    ...overrides,
  };
}

describe('decideApiRetry', () => {
  it('retries a turn that ended on a transient error once a minute passed, not before, counting the retry', () => {
    assert.deepEqual(decideApiRetry(failed(), FAIL_AT + MS_PER_MINUTE - 1), { kind: 'later', at: FAIL_AT + MS_PER_MINUTE });
    const now = FAIL_AT + MS_PER_MINUTE;
    assert.deepEqual(decideApiRetry(failed(), now), {
      kind: 'retry',
      code: 'server_error',
      failedAt: FAIL_AT,
      n: 1,
      entry: failed({ retries: 1, retriedAt: now }),
    });
  });

  it('waits 5, then 15 minutes after the last retry, and from a failure that came after it', () => {
    const retriedAt = FAIL_AT + MS_PER_MINUTE;
    assert.deepEqual(decideApiRetry(failed({ retries: 1, retriedAt }), retriedAt), { kind: 'later', at: retriedAt + 5 * MS_PER_MINUTE });
    assert.deepEqual(decideApiRetry(failed({ retries: 2, retriedAt }), retriedAt), { kind: 'later', at: retriedAt + 15 * MS_PER_MINUTE });
    const failedAgainAt = retriedAt + 2 * MS_PER_MINUTE;
    assert.deepEqual(decideApiRetry(failed({ failedAt: failedAgainAt, retries: 1, retriedAt }), retriedAt), { kind: 'later', at: failedAgainAt + 5 * MS_PER_MINUTE });
  });

  it('gives up after the last retry', () => {
    assert.equal(API_RETRY_LIMIT, 3);
    assert.deepEqual(decideApiRetry(failed({ retries: 3, retriedAt: FAIL_AT }), FAIL_AT + 24 * 60 * MS_PER_MINUTE), { kind: 'none' });
  });

  it('retries overloaded and server_error only: a rate limit, an expired login, an unknown or unnamed error are not', () => {
    assert.deepEqual([...TRANSIENT_API_ERRORS], ['server_error', 'overloaded']);
    const late = FAIL_AT + 60 * MS_PER_MINUTE;
    assert.equal(decideApiRetry(failed({ code: 'overloaded' }), late).kind, 'retry');
    for (const code of ['rate_limit', 'authentication_failed', 'unknown', 'invalid_request', undefined]) {
      assert.deepEqual(decideApiRetry(failed({ code }), late), { kind: 'none' }, String(code));
    }
  });

  it('leaves a tab no longer stopped on the error: a prompt typed since, a good turn, an end, or no entry', () => {
    const late = FAIL_AT + 60 * MS_PER_MINUTE;
    assert.deepEqual(decideApiRetry(failed({}, { state: 'working' }), late), { kind: 'none' });
    assert.deepEqual(decideApiRetry(failed({}, { state: 'ready', apiError: undefined }), late), { kind: 'none' });
    assert.deepEqual(decideApiRetry(failed({}, { endedAt: FAIL_AT, endReason: 'other' }), late), { kind: 'none' });
    assert.deepEqual(decideApiRetry(undefined, late), { kind: 'none' });
  });
});

describe('claimApiRetry', () => {
  it('writes the counted retry before it answers, so the next check waits for the next backoff', async () => {
    const registry = new RestoreRegistry(new MemoryFiles(), DIR);
    await registry.write(failed());
    const now = FAIL_AT + MS_PER_MINUTE;
    assert.equal((await claimApiRetry(registry, ID, now)).kind, 'retry');
    assert.deepEqual((await registry.read(ID))?.apiError, { code: 'server_error', failedAt: FAIL_AT, retries: 1, retriedAt: now });
    assert.deepEqual(await claimApiRetry(registry, ID, now), { kind: 'later', at: now + 5 * MS_PER_MINUTE });
  });

  it('writes nothing when no retry is due, nor for a tab with no entry', async () => {
    const files = new MemoryFiles();
    const registry = new RestoreRegistry(files, DIR);
    await registry.write(failed());
    const before = await files.read(registry.pathOf(ID));
    assert.equal((await claimApiRetry(registry, ID, FAIL_AT)).kind, 'later');
    assert.equal(await files.read(registry.pathOf(ID)), before);
    const other = '0123abcd-0000-4000-8000-00000000000b';
    assert.deepEqual(await claimApiRetry(registry, other, FAIL_AT), { kind: 'none' });
    assert.equal(await files.read(registry.pathOf(other)), undefined);
  });
});

describe('apiRetriesSpentOn', () => {
  it('names the error once every retry is spent, and nothing before or for another error', () => {
    assert.equal(apiRetriesSpentOn(failed({ retries: 3 })), 'server_error');
    assert.equal(apiRetriesSpentOn(failed({ retries: 2 })), undefined);
    assert.equal(apiRetriesSpentOn(failed({ code: 'rate_limit', retries: 3 })), undefined);
    assert.equal(apiRetriesSpentOn(failed({ retries: 3 }, { state: 'working' })), undefined);
  });
});

describe('API error log lines', () => {
  it('names the tab, the error and the retry, or that it was given up', () => {
    assert.equal(apiRetryLine('app/alpha (x)', 'overloaded', 2), 'api-error: retried app/alpha (x), its turn ended on overloaded; retry 2 of 3');
    assert.equal(apiGaveUpLine('app/alpha (x)', 'server_error'), 'api-error: gave up on app/alpha (x): its turn ended on server_error after 3 retries');
  });
});
