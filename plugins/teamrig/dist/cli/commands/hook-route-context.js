import { recordField, stringField } from "../../core/guards.js";
import { clientRootOf } from "../../exec/client-integrity.js";
import { ClientInstalls, ShellPathSearch } from "../../exec/client-launch.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { gitContextOf } from "../../permissions/route-context.js";
import { ownClientOf } from "../../permissions/route-kit.js";
import { routeOf } from "../../permissions/sanctioned.js";
import { JsonlEventLog } from "../../register/store.js";
import { rosterOf } from "../kit.js";
import { teamSessionOf } from "./hook-input.js";
/**
 * A hook's sanctioned-route lookup (T679): the context `routeOf` needs, read from the hook's runtime and payload. The
 * program word is placed as the Bash tool's shell would place it from the call's folder, the payload's first (Claude
 * Code may start the hook elsewhere); the tab's session and the register are read only when a push line asks.
 */
export function routeContextOf(runtime, kit, config, payload, cli) {
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
export async function callRouteOf(runtime, kit, config, payload, cli) {
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (stringField(payload, 'tool_name') !== 'Bash' || command === undefined) {
        return undefined;
    }
    return routeOf(command, routeContextOf(runtime, kit, config, payload, cli)).catch(() => undefined);
}
