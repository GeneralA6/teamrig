import { KIT_NAME } from "../../core/home.js";
import { reminderFor, sessionIdOf } from "../../inbox/inbox.js";
import { protectedBranchesOf, pushGuardOutput } from "../../hooks/push-guard.js";
import { noPositionals } from "../args.js";
import { openKit } from "../kit.js";
import { EXIT } from "../runtime.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call.
 */
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    // A config that cannot even be opened keeps the default branches: it never turns the guard off.
    const load = await openKit(runtime).then((kit) => kit.load, () => undefined);
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
/** UserPromptSubmit: one line of context when the session's inbox has unread lines. */
export async function inboxReminder(args, runtime) {
    noPositionals(args);
    const claudeSession = sessionIdOf(await runtime.readStdin());
    if (claudeSession === null) {
        return EXIT.ok;
    }
    const kit = await openKit(runtime);
    if (kit.load.status !== 'loaded') {
        return EXIT.ok;
    }
    const line = await reminderFor(inboxDepsOf(runtime, kit.paths), claudeSession, KIT_NAME);
    if (line !== undefined) {
        runtime.out.stdout(line);
    }
    return EXIT.ok;
}
