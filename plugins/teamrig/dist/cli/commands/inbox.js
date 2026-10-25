import { LeadTree } from "../../config/lead-tree.js";
import { formatAddress } from "../../core/address.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { NAME_RULE } from "../../core/ids.js";
import { PlainLogFile } from "../../core/log-file.js";
import { SecretScanner } from "../../core/secrets.js";
import { groupIds, parseTo, treeLeadsOf } from "../../inbox/groups.js";
import { formatRead, formatStatus, inboxStatus, lineOnClock, postLines, readInbox } from "../../inbox/inbox.js";
import { CLAUDE_SESSION_ID } from "../../inbox/marks.js";
import { reachOf } from "../../inbox/reach.js";
import { routeReminderOf } from "../../inbox/route.js";
import { InboxDir, JsonlMarkLog } from "../../inbox/store.js";
import { noPositionals, requiredFlag, UsageError } from "../args.js";
import { hookLogOf } from "../hook-logs.js";
import { callerOf, sessionRef } from "../inputs.js";
import { findTeam, openKit, openTeamKit, pastOrPresentIdOf, requireConfig, rosterOf, sessionIdOf, teamZone } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { loadTree } from "../tree.js";
import { verifyNoteOf } from "./verify-queue.js";
export function inboxDepsOf(runtime, paths) {
    return {
        inboxes: new InboxDir(runtime.files, paths.inbox),
        marks: new JsonlMarkLog(new PlainLogFile(runtime.files, paths.inboxMarks)),
        shown: new JsonlMarkLog(hookLogOf(runtime, paths, 'inbox-shown')),
    };
}
/** The Claude Code session running the command, so the reminder hook can follow it; null outside one. */
function claudeSessionOf(env) {
    const id = env[ENV.claudeSession];
    return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : null;
}
/**
 * `inbox read`: prints the caller's unread lines, but those the prompt hook showed this Claude Code
 * session, and marks them all read; then, when the caller holds verifying tasks, its verify queue in one line.
 */
export async function read(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const area = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const now = new Date(runtime.clock.now());
    const result = await readInbox(inboxDepsOf(runtime, kit.paths), { area, claudeSession: claudeSessionOf(runtime.env), now });
    const zone = teamZone(config, runtime);
    result.lines.forEach((line) => runtime.out.stdout(lineOnClock(line, zone)));
    runtime.out.stdout(formatRead(result));
    const verify = await verifyNoteOf(runtime, kit.paths, area);
    if (verify !== undefined) {
        runtime.out.stdout(verify);
    }
    return EXIT.ok;
}
/** `inbox status`: unread counts per area, marking nothing. */
export async function status(args, runtime) {
    noPositionals(args);
    const only = args.flags.get('session');
    const ref = only === undefined ? undefined : sessionRef('--session', only);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const area = ref === undefined ? undefined : pastOrPresentIdOf(roster, ref);
    const statuses = await inboxStatus(inboxDepsOf(runtime, kit.paths), area);
    if (statuses.length === 0) {
        runtime.out.stdout(`INBOX no inbox ${area === undefined ? 'files' : `for ${area}`} in ${kit.paths.inbox}`);
    }
    const zone = teamZone(config, runtime);
    statuses.forEach((item) => runtime.out.stdout(formatStatus(item, zone)));
    return EXIT.ok;
}
function ownTeamRecipient(own, id) {
    return { paths: own.paths, config: own.config, id, label: id, sender: own.from.id, crossing: false };
}
function teamOf(loaded, team) {
    const target = loaded.teams.get(team);
    if (target === undefined) {
        throw new RefusedError(`no team ${team} with a config in this kit home`);
    }
    return target;
}
/** A session of another team, when it is in the sender's tree (reachOf). */
function recipientInTree(runtime, loaded, from, to) {
    const target = teamOf(loaded, to.team);
    const reach = reachOf(loaded.tree, from, to);
    if (!reach.ok) {
        throw new RefusedError(reach.problem);
    }
    return { paths: target.kit.paths, config: requireConfig(target.kit, runtime, 'write'), id: to.id, label: formatAddress(to), sender: formatAddress(from), crossing: true };
}
/** A session of the sender's tree as `{ team, id }`: the sender's own team takes the own-team form, the sender left out. */
function recipientsAt(runtime, own, loaded, addresses) {
    return addresses
        .filter((to) => to.team !== own.from.team || to.id !== own.from.id)
        .map((to) => (to.team === own.from.team ? ownTeamRecipient(own, to.id) : recipientInTree(runtime, loaded, own.from, to)));
}
/** `tree:leads`: every team's lead in the sender's tree, root first; refused when the tree has no root. */
function treeLeadRecipients(runtime, own, loaded) {
    const leads = treeLeadsOf(loaded.tree, own.from.team);
    if (leads === undefined) {
        throw new RefusedError(`the parent teams above ${own.from.team} go round a loop, so its tree has no leads to list: teamrig doctor names the loop`);
    }
    return recipientsAt(runtime, own, loaded, leads);
}
/** The recipients one `--to` item names: a group of the sender's team or of its tree, or one session of its tree. */
async function recipientsOfItem(runtime, own, item, tree) {
    if (item.kind === 'session') {
        const { team, session } = item.address;
        if (team === undefined || team === own.from.team) {
            return [ownTeamRecipient(own, sessionIdOf(own.roster, session))];
        }
        const loaded = await tree();
        return [recipientInTree(runtime, loaded, own.from, { team, id: sessionIdOf(teamOf(loaded, team).roster, session) })];
    }
    if (item.kind === 'team') {
        const loaded = await tree();
        return recipientsAt(runtime, own, loaded, teamOf(loaded, item.team).config.sessions.map((id) => ({ team: item.team, id })));
    }
    if (item.kind === 'tree-leads') {
        return treeLeadRecipients(runtime, own, await tree());
    }
    const group = item.kind === 'group' ? { kind: item.kind, leader: sessionIdOf(own.roster, item.leader) } : item;
    const ids = groupIds(own.config, group, own.from.id);
    if (!ids.ok) {
        throw new RefusedError(ids.problem);
    }
    return ids.ids.map((id) => ownTeamRecipient(own, id));
}
/** Every recipient the `--to` items name, each once, in the order first named; refused when none is left. */
async function recipientsOf(runtime, own, items, to) {
    let loaded;
    const tree = () => (loaded ??= loadTree(runtime));
    const byLabel = new Map();
    for (const item of items) {
        for (const recipient of await recipientsOfItem(runtime, own, item, tree)) {
            if (!byLabel.has(recipient.label)) {
                byLabel.set(recipient.label, recipient);
            }
        }
    }
    if (byLabel.size === 0) {
        throw new RefusedError(`--to ${to} names no session but the sender ${own.from.id}`);
    }
    return [...byLabel.values()];
}
function postedLine(recipients) {
    const [only] = recipients;
    if (recipients.length === 1 && only !== undefined) {
        return `POSTED to ${only.label}; ${only.label} is reminded at its next prompt`;
    }
    return `POSTED to ${recipients.length} sessions (${recipients.map((recipient) => recipient.label).join(', ')}); each is reminded at its next prompt`;
}
/**
 * The route reminders (T783) for the sessions of the sender's team that `--to` names one by one, each once. A group
 * (`all`, `leads`, `group:<leader>`, `team:<team>`, `tree:leads`) is a broadcast, not work handed past a sub-lead, so
 * it gets none.
 */
function routeRemindersOf(own, items, text) {
    const tree = new LeadTree(own.config);
    const reminders = new Set();
    for (const item of items) {
        if (item.kind !== 'session' || (item.address.team !== undefined && item.address.team !== own.from.team)) {
            continue;
        }
        const to = sessionIdOf(own.roster, item.address.session);
        const reminder = routeReminderOf(tree, { from: own.from.id, to, text }, (id) => id, KIT_NAME);
        if (reminder !== undefined) {
            reminders.add(reminder);
        }
    }
    return [...reminders];
}
const TO_FORMS = 'a session id or name, <team>/<id>, all, leads, group:<leader>, team:<team>, tree:leads, or a comma-separated list of them';
/**
 * `inbox add --to <to> --text "<line>"`: appends one dated line to each receiver's inbox, all of them or, when one is
 * refused, none. A bare id or name is on the sender's team; `<team>/<id>` reaches any session of another team of its
 * tree, and that line names the sender `<team>/<id>`. `all`, `leads` and `group:<leader>` are groups of the sender's
 * team, `team:<team>` (every session of a team of its tree) and `tree:leads` (every team's lead of its tree) groups of
 * its tree; a group leaves the sender out, and a comma-separated list names each receiver once. A line to a
 * session named on the sender's team that skips a sub-lead below the sender is posted, then a further line tells the
 * sender to route such work via that sub-lead (T783).
 */
export async function add(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const to = requiredFlag(args.flags, 'to');
    const items = parseTo(to);
    if (items === undefined) {
        throw new UsageError(`--to "${to}" is not ${TO_FORMS} (${NAME_RULE})`);
    }
    const text = requiredFlag(args.flags, 'text');
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'write');
    const roster = await rosterOf(runtime, kit, config);
    const own = { from: { team, id: sessionIdOf(roster, caller) }, paths: kit.paths, config, roster };
    const recipients = await recipientsOf(runtime, own, items, to);
    const secrets = new SecretScanner([
        ...config.register.secretPatterns,
        ...recipients.filter((recipient) => recipient.crossing).flatMap((recipient) => recipient.config.register.secretPatterns),
    ]);
    const targets = recipients.map((recipient) => ({ inboxes: inboxDepsOf(runtime, recipient.paths).inboxes, to: recipient.id, from: recipient.sender }));
    const problem = await postLines(targets, secrets, { text, now: new Date(runtime.clock.now()) });
    if (problem !== undefined) {
        throw new RefusedError(problem);
    }
    runtime.out.stdout(postedLine(recipients));
    for (const reminder of routeRemindersOf(own, items, text)) {
        runtime.out.stdout(reminder);
    }
    return EXIT.ok;
}
