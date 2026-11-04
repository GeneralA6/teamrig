import { isRecord } from "../../core/guards.js";
import { toJsonlLine } from "../../core/jsonl.js";
import { passRecordGuardOutput } from "../../hooks/pass-record-guard.js";
import { guardsPassed, preToolUseRouteOf, routeAllowOn, routeAllowOutput, routeAllowRecord } from "../../hooks/route-allow.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { noPositionals } from "../args.js";
import { hookLogOf } from "../hook-logs.js";
import { EXIT } from "../runtime.js";
import { guardLoadOf } from "./hook-guard-load.js";
import { execGuardOutputOf, packageGuardOutputOf, pushGuardOutputOf, secretGuardOutputOf } from "./hook-guard-outputs.js";
import { envSession, parseJson } from "./hook-input.js";
import { callRouteOf } from "./hook-route-context.js";
/**
 * What the hook prints for this payload: an allow for a line that runs a route marked for PreToolUse, once every teamrig
 * guard passed the same call with the same config load its own hook reads; else ''. Each allow is logged by its route.
 */
async function routeAllowOutputOf(runtime, payload, deps) {
    const guard = await guardLoadOf(payload, runtime);
    const kit = guard?.kit;
    if (guard === undefined || kit === undefined || kit.load.status !== 'loaded' || !routeAllowOn(kit.load.config.prompts)) {
        return '';
    }
    const route = preToolUseRouteOf(await callRouteOf(runtime, kit, kit.load.config, payload, deps.table));
    if (route === undefined) {
        return '';
    }
    const answers = await Promise.all([
        pushGuardOutputOf(runtime, guard, payload),
        packageGuardOutputOf(runtime, guard, payload),
        execGuardOutputOf(runtime, guard, payload),
    ]);
    if (!guardsPassed([...answers, secretGuardOutputOf(runtime, guard, payload), passRecordGuardOutput(payload)])) {
        return '';
    }
    const record = routeAllowRecord({ at: new Date(runtime.clock.now()), session: envSession(runtime), claudeSession: sessionIdOf(payload), route: route.id });
    // Best effort, like the prompt answers: a full disk or a held lock must not take the allow away.
    await hookLogOf(runtime, kit.paths, 'prompt-answers').append(toJsonlLine(record)).catch(() => undefined);
    return routeAllowOutput(route);
}
/**
 * PreToolUse on Bash: under `prompts.hookAsks: refuse` with `prompts.routeAllow` on (its default), lets a line that runs
 * a sanctioned route marked for it (permissions/sanctioned.ts: merge, deploy, exec request, worktree remove, git commit)
 * run with no permission check, once the push, package, secret, exec and pass-record guards all passed it; logs each
 * allow to `state/prompt-answers.jsonl` by its route, never its command. Outside a team, with asks on, the switch off or
 * the config missing or broken, for any other line or tool, when a guard asks or refuses, for input that is not a hook
 * payload or on any error, it prints nothing, so the guards and Claude Code's own permission check decide: it fails
 * closed.
 */
export function routeAllow(deps) {
    return async (args, runtime) => {
        noPositionals(args);
        const payload = parseJson(await runtime.readStdin());
        const output = isRecord(payload) ? await routeAllowOutputOf(runtime, payload, deps).catch(() => '') : '';
        if (output !== '') {
            runtime.out.stdout(output);
        }
        return EXIT.ok;
    };
}
