import type { KitConfig } from '../../config/types.ts';
import { clientRootOf } from '../../exec/client-integrity.ts';
import { ClientInstalls, ShellPathSearch } from '../../exec/client-launch.ts';
import { gitContextOf } from '../../permissions/route-context.ts';
import { ownClientOf, type KitContext } from '../../permissions/route-kit.ts';
import { shellRouteOf, type RouteContext, type SanctionedRoute } from '../../permissions/sanctioned.ts';
import type { HookEvent } from '../../ports/host/index.ts';
import { JsonlEventLog } from '../../register/store.ts';
import type { CommandTable } from '../../slash/plan.ts';
import { rosterOf, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamSessionOf } from './hook-input.ts';

/** The folder a tool call runs in: the event's, else the hook's own (the host may start the hook elsewhere). */
function callCwdOf(runtime: CliRuntime, event: HookEvent): string {
  return event.cwd ?? runtime.cwd;
}

/**
 * What a hook reads a teamrig line with: the CLI's table, and whether the program word is this install's own launcher,
 * placed as a bash call's shell would place it from the call's folder, the event's first (the host may start the hook
 * elsewhere).
 */
export function kitContextOf(runtime: CliRuntime, event: HookEvent, cli: CommandTable): KitContext {
  const cwd = callCwdOf(runtime, event);
  const search = new ShellPathSearch({ env: runtime.env, platform: runtime.platform, probe: runtime.probe });
  const installs = new ClientInstalls(clientRootOf(runtime.self.script), runtime.platform);
  return { cli, ownClient: ownClientOf(search, installs, { dialect: 'bash', dir: cwd, home: runtime.userHome }) };
}

/**
 * A hook's sanctioned-route lookup (T679): the context `routeOf` needs, read from the hook's runtime and event; the
 * tab's session and the register are read only when a push line asks.
 */
export function routeContextOf(runtime: CliRuntime, kit: Kit, config: KitConfig, event: HookEvent, cli: CommandTable): RouteContext {
  const cwd = callCwdOf(runtime, event);
  return {
    ...kitContextOf(runtime, event, cli),
    ...gitContextOf({
      cwd,
      home: runtime.userHome,
      git: runtime.git,
      caller: async () => teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), event.session ?? null),
      ownerOf: async (task) => (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(task)?.owner,
      protectedBranches: config.pushGuard.protectedBranches,
    }),
  };
}

/**
 * The route a bash call's line runs, in every text bash may run (`shellRouteOf`); undefined for any other call, a line
 * that is none, or a lookup that fails.
 */
export async function callRouteOf(runtime: CliRuntime, kit: Kit, config: KitConfig, event: HookEvent, cli: CommandTable): Promise<SanctionedRoute | undefined> {
  const { call } = event;
  if (call?.kind !== 'shell' || call.dialect !== 'bash' || call.command === undefined) {
    return undefined;
  }
  return shellRouteOf(call, routeContextOf(runtime, kit, config, event, cli)).catch(() => undefined);
}
