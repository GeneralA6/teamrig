import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeAnswerOf } from './probe.ts';

const TAG = 'W/"50b22ce0798d5266d68ab18f566208f054bace28abff5bdb55246daea34bb6d5"';

/** What gh printed, as `gh api -i` prints it: status line, headers, a blank line, then the body. */
function printed(status: string, headers: readonly string[], body = '', code = 0): { end: { kind: 'exited'; code: number }; stdout: string; stderr: string } {
  return { end: { kind: 'exited', code }, stdout: [`HTTP/2.0 ${status}`, ...headers, '', body].join('\r\n'), stderr: code === 0 ? '' : `gh: HTTP ${status.slice(0, 3)}\n` };
}

describe('probeAnswerOf', () => {
  it('reads a 200 as changed, with its entity tag, the header named in any case', () => {
    assert.deepEqual(probeAnswerOf(printed('200 OK', ['Content-Type: application/json', `Etag: ${TAG}`], '[{"number":1}]')), { kind: 'changed', tag: TAG });
    assert.deepEqual(probeAnswerOf(printed('200 OK', ['ETAG: "x"'])), { kind: 'changed', tag: '"x"' });
  });

  it('reads a 304 as unchanged, though gh exits 1 for it', () => {
    assert.deepEqual(probeAnswerOf(printed('304 Not Modified', [`Etag: ${TAG.slice(2)}`], '', 1)), { kind: 'unchanged' });
  });

  it('drops a missing or malformed tag, so the next probe reads the whole answer', () => {
    assert.deepEqual(probeAnswerOf(printed('200 OK', [])), { kind: 'changed', tag: undefined });
    assert.deepEqual(probeAnswerOf(printed('200 OK', ['Etag: "a b"'])), { kind: 'changed', tag: undefined });
    assert.deepEqual(probeAnswerOf(printed('200 OK', ['Etag: unquoted'])), { kind: 'changed', tag: undefined });
  });

  it('reads an error status or no status line as failed, saying why on one line', () => {
    assert.deepEqual(probeAnswerOf(printed('404 Not Found', [], '{"message":"Not Found"}', 1)), { kind: 'failed', reason: 'GitHub answered HTTP 404: gh: HTTP 404' });
    assert.deepEqual(probeAnswerOf({ end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'error connecting to api.github.com\ncheck your internet connection' }), {
      kind: 'failed',
      reason: 'gh api exited with code 1: error connecting to api.github.com',
    });
    assert.deepEqual(probeAnswerOf({ end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' }), { kind: 'failed', reason: 'gh api was stopped (SIGTERM)' });
  });

  it('reads only the head, never a status-like line in the body', () => {
    assert.deepEqual(probeAnswerOf(printed('200 OK', ['Etag: "a"'], 'HTTP/2.0 304 Not Modified')), { kind: 'changed', tag: '"a"' });
  });
});
