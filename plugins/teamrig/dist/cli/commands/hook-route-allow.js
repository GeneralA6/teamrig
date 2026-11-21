import { toJsonlLine } from "../../core/jsonl.js";
import { passRecordGuardReply } from "../../hooks/pass-record-guard.js";
import { guardsPassed, preToolUseRouteOf, routeAllowOn, routeAllowRecord, routeAllowReply } from "../../hooks/route-allow.js";
import { noPositionals } from "../args.js";
import { hookLogOf } from "../hook-logs.js";
import { EXIT } from "../runtime.js";
import { guardLoadOf } from "./hook-guard-load.js";
import { dbWriteGuardReplyOf, execGuardReplyOf, packageGuardReplyOf, pushGuardReplyOf, secretGuardReplyOf, serviceRoleGuardReplyOf } from "./hook-guard-outputs.js";
import { envSession, readHookInput, writeReply } from "./hook-input.js";
import { roleAllowReplyOf } from "./hook-role-allow.js";
import { callRouteOf } from "./hook-route-context.js";
/** True when every teamrig guard passed the call, with the same config load its own hook reads (Q7.1). */
async function everyGuardPassed(runtime, guard, event) {
    const answers = await Promise.all([
        pushGuardReplyOf(runtime, guard, event),
        packageGuardReplyOf(runtime, guard, event),
        execGuardReplyOf(runtime, guard, event),
        dbWriteGuardReplyOf(runtime, guard, event),
        serviceRoleGuardReplyOf(runtime, guard, event),
    ]);
    return guardsPassed([...answers, secretGuardReplyOf(runtime, guard, event), passRecordGuardReply(event)]);
}
/**
 * The hook's reply to this call: an allow for a line that runs a route marked for the allow before a tool runs, or for
 * a service role's call (hook-role-allow.ts), once every teamrig guard passed the same call; else none. Each allow is
 * logged by its route or its role.
 */
async function routeAllowReplyOf(runtime, event, deps) {
    const guard = await guardLoadOf(event.cwd, runtime);
    const kit = guard?.kit;
    if (guard === undefined || kit === undefined || kit.load.status !== 'loaded') {
        return undefined;
    }
    const passed = () => everyGuardPassed(runtime, guard, event);
    if (!routeAllowOn(kit.load.config.prompts)) {
        return roleAllowReplyOf(runtime, kit, event, deps.table, passed);
    }
    const route = preToolUseRouteOf(await callRouteOf(runtime, kit, kit.load.config, event, deps.table));
    if (route === undefined) {
        return roleAllowReplyOf(runtime, kit, event, deps.table, passed);
    }
    if (!(await passed())) {
        return undefined;
    }
    const record = routeAllowRecord({ at: new Date(runtime.clock.now()), session: envSession(runtime), claudeSession: event.session ?? null, route: route.id });
    // Best effort, like the prompt answers: a full disk or a held lock must not take the allow away.
    await hookLogOf(runtime, kit.paths, 'prompt-answers').append(toJsonlLine(record)).catch(() => undefined);
    return routeAllowReply(route);
}
/**
 * PreToolUse on Bash: under `prompts.hookAsks: refuse` with `prompts.routeAllow` on (its default), lets a line that runs
 * a sanctioned route marked for it (permissions/sanctioned.ts: merge, deploy, exec request, worktree remove, git commit)
 * run with no permission check, once the push, package, secret, exec, db-write and pass-record guards all passed it; logs each
 * allow to `state/prompt-answers.jsonl` by its route, never its command. With the switch on, whatever asks say, it also
 * lets a service role's call run for the tab bound to a holder of the role, up to the role's daily cap, then asks
 * (T2984, hook-role-allow.ts). Outside a team, with the switch off or the config missing or broken, for any other line
 * or tool, when a guard asks or refuses, for input that is not a hook payload or on any error, it prints nothing, so
 * the guards and Claude Code's own permission check decide: it fails closed.
 */
export function routeAllow(deps) {
    return async (args, runtime) => {
        noPositionals(args);
        const { event } = await readHookInput(runtime);
        const reply = event === undefined ? undefined : await routeAllowReplyOf(runtime, event, deps).catch(() => undefined);
        writeReply(runtime, 'tool-start', reply);
        return EXIT.ok;
    };
}
