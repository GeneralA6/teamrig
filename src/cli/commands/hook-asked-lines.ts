import { stringField, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { LockBusyError } from '../../core/lock.ts';
import { injectFor } from '../../inbox/inject.ts';
import { unseenLinesOf } from '../../inbox/inbox.ts';
import { asksNowOf, WakeAsks } from '../../wake/asks.ts';
import { WakeStore } from '../../wake/store.ts';
import { teamZone } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { wakeScopeOf } from './hook-wake.ts';
import { inboxDepsOf } from './inbox.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * A busy session's side of a wake ask (src/wake/asks.ts): at a tool's end on its main thread, once an ask waits for
 * it, the session's new inbox lines (src/inbox/inject.ts), recorded as shown so the prompt hook never repeats them.
 * Every ask is also an inbox line (src/cli/urgent-line.ts posts the line first), so the lines show each ask read; those
 * asks go, with the spent ones (damaged, or timed with their line seen), and the wake check does not wake the tab
 * after its turn for lines it already saw. A timed ask (`inbox add --wake-by`) counts only from its time. It runs
 * under the session's wake lock, so a wake check never quotes an ask this takes; with the lock busy (a check deciding)
 * the next tool end looks again. Undefined when no ask is due, at a helper's tool end, outside a team session or with
 * `wake.enabled` false, which posts no asks.
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
  const { files, clock } = runtime;
  const asks = new WakeAsks(files, kit.paths.wakeAsks);
  const unseen = (): Promise<ReadonlySet<string>> => unseenLinesOf(inboxDepsOf(runtime, kit.paths), id);
  // Read first without the lock: at nearly every tool end none is due, and the lock is a file write.
  const first = await asksNowOf(await asks.read(id), clock.now(), unseen);
  if (first.asks.length === 0 && first.spent.length === 0) {
    return undefined;
  }
  const lock = fileLockOf(runtime, new WakeStore(files, kit.paths.wake).lockOf(id), { ...config.lock, waitMs: 0 });
  try {
    return await lock.run(async (): Promise<string | undefined> => {
      const found = await asksNowOf(await asks.read(id), clock.now(), unseen);
      if (found.asks.length === 0) {
        await asks.remove(id, found.spent);
        return undefined;
      }
      const lines = await injectFor(inboxDepsOf(runtime, kit.paths), { area: id, claudeSession: tab, now: new Date(clock.now()), zone: teamZone(config, runtime), command: KIT_NAME });
      await asks.remove(id, found.taken);
      return lines;
    });
  } catch (error) {
    if (error instanceof LockBusyError) {
      return undefined;
    }
    throw error;
  }
}
