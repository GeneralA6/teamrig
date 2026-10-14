import { rm } from 'node:fs/promises';
import { DIST_DIR } from '../ci/dist-fresh.ts';

// Rebuilding from empty makes a deleted source show up as a deleted dist file in the freshness check.
await rm(DIST_DIR, { recursive: true, force: true });
