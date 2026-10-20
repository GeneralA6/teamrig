import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { CLIENT_FOLDERS, CLIENT_MANIFEST, clientFileHash, clientManifestText } from '../../src/exec/client-integrity.ts';
import { DIST_DIR } from '../ci/dist-fresh.ts';

// Runs after tsc: lists a hash of every client file, so the exec guard can tell an installed client edited by hand
// (src/exec/client-integrity.ts). The freshness check then catches a launcher or hook edited without a rebuild.
const pluginRoot = dirname(DIST_DIR);
const manifestPath = join(pluginRoot, CLIENT_MANIFEST);
const manifest = new Map<string, string>();
for (const folder of CLIENT_FOLDERS) {
  for (const entry of await readdir(join(pluginRoot, folder), { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && path !== manifestPath) {
      manifest.set(relative(pluginRoot, path).replaceAll('\\', '/'), clientFileHash(await readFile(path, 'utf8')));
    }
  }
}
await writeFile(manifestPath, clientManifestText(manifest));
