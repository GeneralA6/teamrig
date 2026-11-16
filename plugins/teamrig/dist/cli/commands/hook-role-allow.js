import { recordField, stringField } from "../../core/guards.js";
import { toJsonlLine } from "../../core/jsonl.js";
import { ROLE_CAP_WINDOW_MS, roleAllowOutput, roleAllowRecord, roleAllowsSince, roleCapOutput, roleHolding } from "../../hooks/service-role-allow.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { isIssueCommand } from "../../permissions/service-commands.js";
import { toolRoleCallOf } from "../../permissions/service-role-call.js";
import { shipBranchOf, shipToolTest } from "../ship-role-check.js";
import { hookLogOf } from "../hook-logs.js";
import { rosterOf } from "../kit.js";
import { tabSessionOf } from "../tab-session.js";
import { kitContextOf } from "./hook-route-context.js";
/**
 * The session the tab holds roles as (T2984, condition C1): the one area its every inbox mark names, on the roster, and
 * the same session the call names with its `--session`, which every role call carries, so a flag never lends a tab
 * another session's role; undefined otherwise.
 */
async function holderOf(runtime, kit, config, claudeSession, caller) {
    const roster = await rosterOf(runtime, kit, config);
    return tabSessionOf(runtime.files, kit.paths.inboxMarks, roster, claudeSession, caller);
}
/**
 * What the route-allow hook prints for a service role's call: an allow when the tab's holder holds a role giving the
 * call's command, every guard passed it (`guardsPass`), a close or comment is under the role's daily cap and a ship or
 * merge runs the team's landed ship tool on the holder's own task branch (ship-role-check.ts); an ask of the owner past
 * the cap; else '', so the permission check decides. It answers only with the switch on and a config that loaded with
 * no issue from this release (a newer one's or a broken key's config gives no role), and only once the allow is
 * logged: the cap counts the log, so a log it cannot write lets nothing past.
 */
export async function roleAllowOutputOf(runtime, kit, payload, cli, guardsPass) {
    const { load } = kit;
    if (load.status !== 'loaded' || load.issues.length > 0 || load.newerVersion !== undefined || load.config.prompts.routeAllow !== 'on') {
        return '';
    }
    const { config } = load;
    const claudeSession = sessionIdOf(payload);
    const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
    if (claudeSession === null || command === undefined) {
        return '';
    }
    const context = { ...kitContextOf(runtime, payload, cli), repos: config.github.repos, isShipTool: shipToolTest(kit, config) };
    const call = await toolRoleCallOf(stringField(payload, 'tool_name'), command, runtime.platform, context);
    const holder = call === undefined ? undefined : await holderOf(runtime, kit, config, claudeSession, call.session);
    const role = call === undefined || holder === undefined ? undefined : roleHolding(config.serviceRoles, call.command, holder);
    if (call === undefined || holder === undefined || role === undefined) {
        return '';
    }
    // A ship is held to the holder's own task branch (C4) and logged by it; a close or comment counts toward the cap (C6).
    const target = 'ship' in call ? await shipBranchOf(runtime, kit, config, holder, call.ship) : call.target;
    if (target === undefined || !(await guardsPass())) {
        return '';
    }
    const log = hookLogOf(runtime, kit.paths, 'prompt-answers');
    const now = runtime.clock.now();
    const cap = config.prompts.serviceRoleDailyCap;
    if (isIssueCommand(call.command) && roleAllowsSince((await log.read()) ?? '', role, now - ROLE_CAP_WINDOW_MS) >= cap) {
        return roleCapOutput(role, cap, config.prompts.hookAsks);
    }
    const acted = { command: call.command, target };
    await log.append(toJsonlLine(roleAllowRecord({ at: new Date(now), session: holder, claudeSession, role, call: acted })));
    return roleAllowOutput(role, acted);
}
