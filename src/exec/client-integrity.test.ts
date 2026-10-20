import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { CLIENT_MANIFEST, checkClient, clientFileHash, clientManifestText, clientRootOf, parseClientManifest } from './client-integrity.ts';

const ROOT = resolve('/', 'plugin');
const MAIN = 'dist/cli/main.js';
const LAUNCHER = 'bin/teamrig';

/** A plugin install whose list was built from `built`, with `installed` as the files on disk now. */
function install(built: Readonly<Record<string, string>>, installed: Readonly<Record<string, string>> = built): MemoryFiles {
  const manifest = new Map(Object.entries(built).map(([path, text]) => [path, clientFileHash(text)]));
  return new MemoryFiles({
    [join(ROOT, CLIENT_MANIFEST)]: clientManifestText(manifest),
    ...Object.fromEntries(Object.entries(installed).map(([path, text]) => [join(ROOT, path), text])),
  });
}

const BUILT = { [MAIN]: 'export {};\n', [LAUNCHER]: '#!/bin/sh\nexec node main.js\n' };

describe('checkClient', () => {
  it('finds an install whose files are the ones the build hashed intact, whatever their line endings', async () => {
    assert.deepEqual(await checkClient(ROOT, install(BUILT)), { kind: 'intact' });
    const crlf = { ...BUILT, [LAUNCHER]: '#!/bin/sh\r\nexec node main.js\r\n' };
    assert.deepEqual(await checkClient(ROOT, install(BUILT, crlf)), { kind: 'intact' });
  });

  it('names each file edited or removed since the build', async () => {
    const patched = { [MAIN]: 'export {}; process.exit(0);\n' };
    assert.deepEqual(await checkClient(ROOT, install(BUILT, patched)), { kind: 'changed', paths: [LAUNCHER, MAIN] });
  });

  it('reports a missing or unreadable list, and a file it cannot read as changed', async () => {
    assert.deepEqual(await checkClient(ROOT, new MemoryFiles()), { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is missing` });
    const broken = new MemoryFiles({ [join(ROOT, CLIENT_MANIFEST)]: '{"files":{}}' });
    assert.deepEqual(await checkClient(ROOT, broken), { kind: 'no-manifest', why: `${CLIENT_MANIFEST} is not a list of file hashes` });
    const faulty = new FaultyFiles(install(BUILT)).fail('read', join(ROOT, MAIN), systemError('EACCES'));
    assert.deepEqual(await checkClient(ROOT, faulty), { kind: 'changed', paths: [MAIN] });
  });
});

describe('clientRootOf', () => {
  it('finds the plugin root three folders above the CLI entry script', () => {
    assert.equal(clientRootOf(join(ROOT, MAIN)), ROOT);
  });
});

describe('client manifest text', () => {
  it('writes the files sorted, so a rebuild of the same code writes the same text, and reads it back', () => {
    const hash = clientFileHash('x');
    const text = clientManifestText(new Map([['dist/b.js', hash], ['bin/teamrig', hash]]));
    assert.equal(text, `{\n  "files": {\n    "bin/teamrig": "${hash}",\n    "dist/b.js": "${hash}"\n  }\n}\n`);
    assert.deepEqual(parseClientManifest(text), new Map([['bin/teamrig', hash], ['dist/b.js', hash]]));
  });

  it('refuses a text that is not a non-empty list of SHA-256 hashes', () => {
    for (const text of ['not json', '[]', '{"files":[]}', '{"files":{}}', '{"files":{"a":"abc"}}', '{"files":{"a":1}}']) {
      assert.equal(parseClientManifest(text), undefined, text);
    }
  });
});
