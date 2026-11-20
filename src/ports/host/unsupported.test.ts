import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUnsupported, unsupported } from './unsupported.ts';

describe('a port a host cannot fill', () => {
  it('holds the reason a human reads', () => {
    assert.deepEqual(unsupported('this tool keeps no session log'), { kind: 'unsupported', notice: 'this tool keeps no session log' });
  });

  it('is told apart from a port, whatever fields the port has', () => {
    assert.equal(isUnsupported(unsupported('no session log')), true);
    assert.equal(isUnsupported({ entry: () => undefined }), false);
    assert.equal(isUnsupported({ kind: 'unsupported' }), false);
    assert.equal(isUnsupported({ kind: 'unsupported', notice: 7 }), false);
    assert.equal(isUnsupported({ kind: 'reader', notice: 'no session log' }), false);
  });
});
