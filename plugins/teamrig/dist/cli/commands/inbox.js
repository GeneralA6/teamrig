import { ENV } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { formatRead, formatUnread, inboxStatus, postLine, readInbox } from "../../inbox/inbox.js";
import { CLAUDE_SESSION_ID } from "../../inbox/marks.js";
import { InboxDir, JsonlMarkLog } from "../../inbox/store.js";
import { noPositionals, requiredFlag } from "../args.js";
import { callerOf, sessionRef } from "../inputs.js";
import { openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
export function inboxDepsOf(runtime, paths) {
    return { inboxes: new InboxDir(runtime.files, paths.inbox), marks: new JsonlMarkLog(runtime.files, paths.inboxMarks) };
}
/** The Claude Code session running the command, so the reminder hook can follow it; null outside one. */
function claudeSessionOf(env) {
    const id = env[ENV.claudeSession];
    return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}
/** `inbox read`: prints the caller's unread lines and marks them read. */
export async function read(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const area = sessionIdOf(rosterOf(kit, requireConfig(kit, runtime, 'read')), caller);
    const now = new Date(runtime.clock.now());
    const result = await readInbox(inboxDepsOf(runtime, kit.paths), { area, claudeSession: claudeSessionOf(runtime.env), now });
    result.unread.lines.forEach((line) => runtime.out.stdout(line));
    runtime.out.stdout(formatRead(result));
    return EXIT.ok;
}
/** `inbox status`: unread counts per area, marking nothing. */
export async function status(args, runtime) {
    noPositionals(args);
    const only = args.flags.get('session');
    const ref = only === undefined ? undefined : sessionRef('--session', only);
    const kit = await openTeamKit(runtime);
    const roster = rosterOf(kit, requireConfig(kit, runtime, 'read'));
    const area = ref === undefined ? undefined : pastOrPresentIdOf(roster, ref);
    const unread = await inboxStatus(inboxDepsOf(runtime, kit.paths), area);
    if (unread.length === 0) {
        runtime.out.stdout(`INBOX no inbox ${area === undefined ? 'files' : `for ${area}`} in ${kit.paths.inbox}`);
    }
    unread.forEach((item) => runtime.out.stdout(formatUnread(item)));
    return EXIT.ok;
}
/** `inbox add`: appends one dated line to a teammate's inbox. */
export async function add(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const recipient = sessionRef('--to', requiredFlag(args.flags, 'to'));
    const text = requiredFlag(args.flags, 'text');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const roster = rosterOf(kit, config);
    const from = sessionIdOf(roster, caller);
    const to = sessionIdOf(roster, recipient);
    const { inboxes } = inboxDepsOf(runtime, kit.paths);
    const now = new Date(runtime.clock.now());
    const problem = await postLine(inboxes, new SecretScanner(config.register.secretPatterns), { to, from, text, now });
    if (problem !== undefined) {
        throw new RefusedError(problem);
    }
    runtime.out.stdout(`POSTED to ${to}: ${inboxes.pathOf(to)}`);
    return EXIT.ok;
}
