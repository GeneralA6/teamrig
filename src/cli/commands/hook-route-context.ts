import type { KitConfig } from '../../config/types.ts';
import { recordField, stringField, type JsonRecord } from '../../core/guards.ts';
import { clientRootOf } from '../../exec/client-integrity.ts';
import { ClientInstalls, ShellPathSearch } from '../../exec/client-launch.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { gitContextOf } from '../../permissions/route-context.ts';
import { ownClientOf } from '../../permissions/route-kit.ts';
import { routeOf, type RouteContext, type SanctionedRoute } from '../../permissions/sanctioned.ts';
import { JsonlEventLog } from '../../register/store.ts';
import type { CommandTable } from '../../slash/plan.ts';
import { rosterOf, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamSessionOf } from './hook-input.ts';

/**
 * A hook's sanctioned-route lookup (T679): the context `routeOf` needs, read from the hook's runtime and payload. The
 * program word is placed as the Bash tool's shell would place it from the call's folder, the payload's first (Claude
 * Code may start the hook elsewhere); the tab's session and the register are read only when a push line asks.
 */
export function routeContextOf(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord, cli: CommandTable): RouteContext {
  const cwd = stringField(payload, 'cwd') ?? runtime.cwd;
  const search = new ShellPathSearch({ env: runtime.env, platform: runtime.platform, probe: runtime.probe });
  const installs = new ClientInstalls(clientRootOf(runtime.self.script), runtime.platform);
  return {
    cli,
    ownClient: ownClientOf(search, installs, { dialect: 'bash', dir: cwd, home: runtime.userHome }),
    ...gitContextOf({
      cwd,
      home: runtime.userHome,
      git: runtime.git,
      caller: async () => teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload)),
      ownerOf: async (task) => (await new JsonlEventLog(runtime.files, kit.paths.events).read()).state.tasks.get(task)?.owner,
      protectedBranches: config.pushGuard.protectedBranches,
    }),
  };
}

/** The route a Bash call's line runs; undefined for any other tool, a line that is none, or a lookup that fails. */
export async function callRouteOf(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord, cli: CommandTable): Promise<SanctionedRoute | undefined> {
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (stringField(payload, 'tool_name') !== 'Bash' || command === undefined) {
    return undefined;
  }
  return routeOf(command, routeContextOf(runtime, kit, config, payload, cli)).catch(() => undefined);
}
