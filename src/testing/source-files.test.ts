import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SRC_DIR, sourcesUnder, underSrc } from './source-files.ts';

describe('sourcesUnder', () => {
  it('reads every source of a folder and of the folders under it, and no test', () => {
    const found = sourcesUnder(SRC_DIR).map(underSrc);
    assert.ok(found.includes('testing/source-files.ts'));
    assert.ok(found.includes('adapters/connectors/github/index.ts'));
    assert.deepEqual(
      found.filter((path) => path.endsWith('.test.ts')),
      [],
    );
    assert.deepEqual(
      found.filter((path) => !path.endsWith('.ts')),
      [],
    );
  });

  it('reads one folder alone when asked for it', () => {
    const found = sourcesUnder(join(SRC_DIR, 'testing')).map(underSrc);
    assert.ok(found.includes('testing/source-files.ts'));
    assert.deepEqual(
      found.filter((path) => !path.startsWith('testing/')),
      [],
    );
  });
});

describe('underSrc', () => {
  it('names a source by its path under src, with a slash on every operating system', () => {
    assert.equal(underSrc(join(SRC_DIR, 'issues', 'ref.ts')), 'issues/ref.ts');
  });
});
