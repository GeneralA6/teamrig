import { heldToday, releaseLineOf } from '../budget/release.ts';
import { WarnStore } from '../budget/warn-store.ts';
import type { KitConfig } from '../config/types.ts';
import type { Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { postUrgentLine } from './urgent-line.ts';

/** A release to announce: the team it is on, who made it (as that team names them), how, and the sessions it may free. */
export interface Release {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly from: string;
  readonly how: string;
  readonly ids: readonly string[];
}

/**
 * Wakes each session of the release held today with the release line (src/budget/release.ts): the inbox keeps the
 * record and the wake ask brings its idle tab back. A session not held is busy or idle for another reason and gets
 * nothing. Prints a WOKE line naming the woken, and a NOTE for each line not posted: the release itself stands.
 */
export async function wakeReleased(runtime: CliRuntime, release: Release, nameOf: (id: string) => string): Promise<void> {
  const held = await heldToday(new WarnStore(runtime.files, release.kit.paths.warn), release.ids, runtime.clock.now());
  const text = releaseLineOf(release.from, release.how);
  const woken: string[] = [];
  for (const id of held) {
    const problem = await postUrgentLine(runtime, release.kit, release.config, { to: id, from: release.from, text });
    if (problem === undefined) {
      woken.push(nameOf(id));
    } else {
      runtime.out.stdout(`NOTE ${nameOf(id)} is still held and was not woken: ${problem}`);
    }
  }
  if (woken.length > 0) {
    runtime.out.stdout(`WOKE ${woken.join(', ')}: held past the daily budget, now free`);
  }
}
