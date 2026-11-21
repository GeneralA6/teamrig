import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { objectOf } from './json.ts';

describe('objectOf', () => {
  it('reads a JSON object, spaces and a line end around it left out', () => {
    assert.deepEqual(objectOf(' {"a":1}\n'), { a: 1 });
  });

  it('gives nothing for a text that is not JSON, or JSON that holds no object', () => {
    assert.equal(objectOf(''), undefined);
    assert.equal(objectOf('{"a":'), undefined);
    assert.equal(objectOf('[1]'), undefined);
    assert.equal(objectOf('null'), undefined);
    assert.equal(objectOf('"text"'), undefined);
  });
});
