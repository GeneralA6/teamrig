import { stringField, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { FileLock, LockBusyError } from '../../core/lock.ts';
import { injectFor } from '../../inbox/inject.ts';
import { WakeAsks } from '../../wake/asks.ts';
import { WakeStore } from '../../wake/store.ts';
import { teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { wakeScopeOf } from './hook-wake.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * A busy session's side of a wake ask (src/wake/asks.ts): at a tool's end on its main thread, once an ask waits for
 * it, the session's new inbox lines (src/inbox/inject.ts), recorded as shown so the prompt hook never repeats them.
 * Every ask is also an inbox line (src/cli/urgent-line.ts posts the line first), so the lines show each ask read; those
 * asks go, valid and damaged, and the wake check does not wake the tab after its turn for lines it already saw. It
 * runs under the session's wake lock, so a wake check never quotes an ask this takes; with the lock busy (a check
 * deciding) the next tool end looks again. Undefined when no ask waits, at a helper's tool end, outside a team session
 * or with `wake.enabled` false, which posts no asks.
 */
export async function askedLinesOf(runtime: CliRuntime, payload: JsonRecord): Promise<string | undefined> {
  // A helper's tool call carries the helper's id (`agent_id`); its context is not the session's.
  if (stringField(payload, 'agent_id') !== undefined) {
    return undefined;
  }
  const scope = await wakeScopeOf(runtime, payload, true);
  if (scope.kind === 'off') {
    return undefined;
  }
  const { kit, config, id, tab } = scope;
  const asks = new WakeAsks(runtime.files, kit.paths.wakeAsks);
  // Read first without the lock: at nearly every tool end none waits, and the lock is a file write.
  if ((await asks.read(id)).length === 0) {
    return undefined;
  }
  const { files, clock, sleep, pid } = runtime;
  const lock = new FileLock(new WakeStore(files, kit.paths.wake).lockOf(id), { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
  try {
    return await lock.run(async (): Promise<string | undefined> => {
      const stored = await asks.read(id);
      if (stored.length === 0) {
        return undefined;
      }
      const lines = await injectFor(inboxDepsOf(runtime, kit.paths), { area: id, claudeSession: tab, now: new Date(clock.now()), zone: teamZone(config, runtime), command: KIT_NAME });
      await asks.remove(id, stored);
      return lines;
    });
  } catch (error) {
    if (error instanceof LockBusyError) {
      return undefined;
    }
    throw error;
  }
}
