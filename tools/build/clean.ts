import { rm } from 'node:fs/promises';
import { DIST_DIR } from './dist-dir.ts';

// Rebuilding from empty keeps a deleted source's compiled file out of the dist the release branch publishes.
await rm(DIST_DIR, { recursive: true, force: true });
