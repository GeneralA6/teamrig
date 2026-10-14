import { isRecord, stringField } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { reminderFor, sessionIdOf } from "../../inbox/inbox.js";
import { protectedBranchesOf, pushGuardOutput } from "../../hooks/push-guard.js";
import { noPositionals } from "../args.js";
import { openKit, teamFolders } from "../kit.js";
import { EXIT } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call. A plugin
 * enabled for the user fires in every project, so outside a team's projects each hook prints
 * nothing at all.
 */
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** The payload's folder first: Claude Code may start the hook process somewhere else. */
function hookTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}
/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const found = await hookTeam(payload, runtime);
    if (found.kind === 'none') {
        return EXIT.ok;
    }
    // A broken pointer, or a config that cannot even be opened, keeps the default branches: neither turns the guard off.
    const load = found.kind === 'team'
        ? await openKit(runtime, found.team).then((kit) => kit.load, () => undefined)
        : undefined;
    const output = pushGuardOutput(payload, {
        cwd: runtime.cwd,
        home: runtime.userHome,
        repo: runtime.git,
        protectedBranches: protectedBranchesOf(load),
    });
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/** UserPromptSubmit: one line of context when the session's inbox has unread lines, or its team pointer is broken. */
export async function inboxReminder(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null) {
        return EXIT.ok;
    }
    const found = await hookTeam(payload, runtime);
    switch (found.kind) {
        case 'none':
            return EXIT.ok;
        case 'broken':
            runtime.out.stdout(`${KIT_NAME}: no team, so no inbox reminder: ${found.from} ${found.problem}`);
            return EXIT.ok;
        case 'team':
            break;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return EXIT.ok;
    }
    const line = await reminderFor(inboxDepsOf(runtime, kit.paths), claudeSession, KIT_NAME);
    if (line !== undefined) {
        runtime.out.stdout(line);
    }
    return EXIT.ok;
}
