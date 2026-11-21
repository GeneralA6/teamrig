/**
 * The released UI this teamrig starts (T4761): a constant of the source, so it ships inside the teamrig release that
 * was reviewed with it. It is never read from the team config, which a session can edit: a pin there would let one
 * point the fetch at an archive of its own. The pull request that pins a teamrig-pane release sets it, with a local
 * rebuild at that tag giving the same sha256. Unset until a release carries the archive.
 */
import type { UiPin } from './released.ts';

export const RELEASED_UI: UiPin | undefined = undefined;
