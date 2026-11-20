import type { HookEvent } from '../../ports/host/index.ts';
import { TabNeedStore, tabNeedOf } from '../../tabs/need.ts';
import { tabChangeOf } from '../../tabs/status.ts';
import type { CliRuntime } from '../runtime.ts';
import { hookScopeOf, type SessionScope } from './hook-input.ts';

/**
 * Records a team session's tab after this hook event in its tab file (src/tabs/need.ts), whatever `tabStatus.enabled`
 * says: what it shows and what it asks the user, so other tabs show which tab needs the user (T2511) and smart focus
 * (T2510) finds it. The session's end removes the file; an event that changes nothing, a tab that is no team session,
 * and a file that already shows the same leave it. Its Claude Code process is this hook's parent, as Claude Code
 * starts its hooks itself. The event also finds the session; `scope` is the caller's when it has one, so the Stop hook
 * reads the roster once.
 */
export async function recordTabNeed(runtime: CliRuntime, event: HookEvent, scope?: SessionScope): Promise<void> {
  const change = tabChangeOf(event);
  if (change === undefined) {
    return;
  }
  const session = scope ?? (await hookScopeOf(runtime, event));
  if (session === undefined) {
    return;
  }
  const store = new TabNeedStore(runtime.files, session.kit.paths);
  if (change === 'reset') {
    await store.remove(session.id);
    return;
  }
  const since = new Date(runtime.clock.now()).toISOString();
  await store.record(tabNeedOf(session.id, change, event, runtime.sessionProcesses.parentPid, since));
}
