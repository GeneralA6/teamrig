import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextIfPresent } from './files.ts';

describe('readTextIfPresent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamrig-files-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a file as UTF-8 text', () => {
    const path = join(dir, 'report.txt');
    writeFileSync(path, 'tests 3 – ok\n');
    assert.equal(readTextIfPresent(path), 'tests 3 – ok\n');
  });

  it('returns undefined when there is no file', () => {
    assert.equal(readTextIfPresent(join(dir, 'missing.txt')), undefined);
  });
});
