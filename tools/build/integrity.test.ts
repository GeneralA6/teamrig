import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_MANIFEST, clientFileHash, parseClientManifest } from '../../src/exec/client-integrity.ts';
import { TempRepo } from '../lib/temp-repo.ts';

const CLI = fileURLToPath(new URL('./integrity.ts', import.meta.url));
const ROOT = 'plugins/teamrig';

describe('integrity', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('integrity');
  });
  afterEach(() => repo.remove());

  it("lists a hash of each launcher, compiled file and hook, and nothing else of the plugin's", () => {
    const files = {
      'bin/teamrig': '#!/bin/sh\n',
      'bin/teamrig.cmd': '@echo off\r\n',
      'dist/cli/main.js': 'export {};\n',
      'hooks/hooks.json': '{}\n',
    };
    for (const [path, text] of Object.entries(files)) {
      repo.write(`${ROOT}/${path}`, text);
    }
    repo.write(`${ROOT}/skills/guide/SKILL.md`, '# guide\n');
    for (const run of [1, 2]) {
      const result = repo.run(CLI);
      assert.equal(result.status, 0, `run ${run}: ${result.stderr}`);
    }
    const text = readFileSync(join(repo.dir, ROOT, CLIENT_MANIFEST), 'utf8');
    const expected = new Map(Object.entries(files).map(([path, body]) => [path, clientFileHash(body)]));
    assert.deepEqual(parseClientManifest(text), expected, 'a second build leaves its own list out');
  });

  it('fails when a client folder is missing, so a broken build never writes a short list', () => {
    repo.write(`${ROOT}/dist/cli/main.js`, 'export {};\n');
    assert.notEqual(repo.run(CLI).status, 0);
    assert.equal(repo.has(`${ROOT}/${CLIENT_MANIFEST}`), false);
  });
});
