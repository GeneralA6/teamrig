import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_PATH_PROBE } from './path-probe.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-probe-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

describe('NODE_PATH_PROBE', () => {
  it('tells files, folders and missing paths apart', async () => {
    const file = join(DIR, 'program.exe');
    writeFileSync(file, '');
    assert.equal(await NODE_PATH_PROBE.kind(file), 'file');
    assert.equal(await NODE_PATH_PROBE.kind(DIR), 'folder');
    assert.equal(await NODE_PATH_PROBE.kind(join(DIR, 'nothing')), 'none');
  });
});
