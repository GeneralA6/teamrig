import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import type { Sleep } from '../core/lock.ts';
import { CONFIG_PATH, TEAM_HOME, type CliHarness } from './cli-harness.ts';
import { holdFileLock } from './held-file-lock.ts';

/** The team config's lock, which every command that changes the config takes (TeamPaths.configLock). */
export const CONFIG_LOCK_PATH = join(TEAM_HOME, 'state', 'hires.lock');

/** A hire's change of the team config: `id` joins its sessions. */
export function hired(id: string): (config: JsonRecord) => JsonRecord {
  return (config) => {
    const sessions = config['sessions'];
    return { ...config, sessions: [...(Array.isArray(sessions) ? sessions : []), id] };
  };
}

/**
 * Another command midway through a change of the team config: it holds the config's lock, and the sleep it gives is
 * the one a run waits on that lock with. At the first wait it writes `change` of the config file and lets the lock go,
 * so the run then reads a config changed between its own first read and its write.
 */
export async function configChangedMeanwhile(kit: CliHarness, change: (config: JsonRecord) => JsonRecord): Promise<Sleep> {
  await holdFileLock(kit, CONFIG_LOCK_PATH);
  let changed = false;
  return async (ms) => {
    if (!changed) {
      changed = true;
      const config = parseObject((await kit.files.read(CONFIG_PATH)) ?? '');
      if (config === undefined) {
        throw new Error(`${CONFIG_PATH} does not hold a JSON object`);
      }
      await kit.files.write(CONFIG_PATH, formatConfig(change(config)));
      await kit.files.remove(CONFIG_LOCK_PATH);
    }
    await kit.clock.sleep(ms);
  };
}
